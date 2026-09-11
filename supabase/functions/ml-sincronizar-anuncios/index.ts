import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function renovarToken(supabase: any, conta: any): Promise<string | null> {
  if (!conta.refresh_token) return null;
  const resp = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conta.refresh_token,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) return null;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await supabase.from("ml_tokens").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? conta.refresh_token,
    expires_at: expiresAt,
    atualizado_em: new Date().toISOString(),
  }).eq("conta", conta.conta);
  return data.access_token;
}

// seller_sku vem como "MARCA: SKU" normal. Kits/combos vem com "+" no meio
// (com ou sem prefixo "KIT:") e ficam de fora do catálogo simples por enquanto
// (marca/sku null) — não representam uma peça única do estoque.
function parseMarcaSku(sellerSku: string | null): { marca: string | null; sku: string | null } {
  if (!sellerSku) return { marca: null, sku: null };
  if (sellerSku.indexOf("+") !== -1) return { marca: null, sku: null };
  const partes = sellerSku.split(":");
  if (partes.length < 2) return { marca: null, sku: null };
  return {
    marca: partes[0].trim().toUpperCase(),
    sku: partes.slice(1).join(":").trim().toUpperCase(),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const url = new URL(req.url);
  const contaFiltro = url.searchParams.get("conta");
  const limite = parseInt(url.searchParams.get("limite") || "0", 10);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let query = supabase.from("ml_tokens").select("conta, user_id, access_token, refresh_token, expires_at");
  if (contaFiltro) query = query.eq("conta", contaFiltro);
  const { data: contas, error: errContas } = await query;

  if (errContas || !contas || contas.length === 0) {
    return new Response(JSON.stringify({ erro: "Conta não encontrada", detalhe: errContas }), {
      status: 404, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const resultado: Record<string, unknown> = {};

  for (const conta of contas) {
    // Marca a hora ANTES de começar a conta. Tudo que esta passada gravar fica com
    // carimbo posterior a ele; o que sobrar com carimbo anterior é anúncio que não
    // existe mais. Um marco por conta, nunca um global: as contas são processadas em
    // sequência e um marco só apagaria anúncios vivos da última.
    const marcoDaPassada = new Date().toISOString();
    let accessToken = conta.access_token;
    const expiraEm = new Date(conta.expires_at).getTime() - Date.now();
    if (expiraEm < 10 * 60 * 1000) {
      const novo = await renovarToken(supabase, conta);
      if (novo) accessToken = novo;
    }

    // Paginação via scroll (necessária pra ir além de 1000 itens, o offset simples não permite)
    const idsTotal: string[] = [];
    let scrollId: string | null = null;
    let primeiraPagina = true;
    while (true) {
      if (limite > 0 && idsTotal.length >= limite) break;
      const params = new URLSearchParams({ search_type: "scan", limit: "100" });
      if (scrollId) params.set("scroll_id", scrollId);
      const resp = await fetch(
        `https://api.mercadolibre.com/users/${conta.user_id}/items/search?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await resp.json();
      if (!resp.ok) {
        resultado[conta.conta] = { erro: "falha ao listar anúncios", detalhe: data };
        break;
      }
      const ids = data.results ?? [];
      if (ids.length === 0 && !primeiraPagina) break;
      idsTotal.push(...ids);
      scrollId = data.scroll_id ?? null;
      primeiraPagina = false;
      if (ids.length === 0 || !scrollId) break;
    }

    if (resultado[conta.conta]) continue;

    const idsParaBuscar = limite > 0 ? idsTotal.slice(0, limite) : idsTotal;

    const anuncios: any[] = [];
    for (let i = 0; i < idsParaBuscar.length; i += 20) {
      const lote = idsParaBuscar.slice(i, i + 20);
      // STATUS E SHIPPING entraram aqui em 10/09/2026.
      //
      // O catálogo tinha os 3.400 anúncios mas não sabia quais estavam PARADOS nem
      // quais tinham Flex — e as duas coisas são o coração da aba "Chegou mercadoria".
      // Sem elas, cada busca teria que perguntar anúncio por anúncio ao ML, o que leva
      // minutos. Com elas, a busca é instantânea.
      const resp = await fetch(
        `https://api.mercadolibre.com/items?ids=${lote.join(",")}&attributes=id,title,category_id,price,available_quantity,attributes,status,shipping`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await resp.json();
      if (!resp.ok) continue;
      for (const entrada of data) {
        if (entrada.code !== 200) continue;
        const item = entrada.body;
        const skuAttr = (item.attributes ?? []).find((a: any) => a.id === "SELLER_SKU");
        const sellerSkuBruto = skuAttr?.value_name ?? null;
        const { marca, sku } = parseMarcaSku(sellerSkuBruto);
        // O Flex vive nas tags do shipping: self_service_in = ligado,
        // self_service_available = o anúncio aceita, esteja ligado ou não.
        const tags: string[] = item.shipping?.tags ?? [];
        anuncios.push({
          conta: conta.conta,
          item_id: item.id,
          title: item.title,
          category_id: item.category_id,
          price: item.price,
          available_quantity: item.available_quantity,
          status: item.status ?? null,
          flex: tags.includes("self_service_in"),
          flex_disponivel: tags.includes("self_service_available") || tags.includes("self_service_in"),
          marca,
          sku,
          seller_sku_bruto: sellerSkuBruto,
          atualizado_em: new Date().toISOString(),
        });
      }
    }

    if (anuncios.length > 0) {
      const { error: errUpsert } = await supabase
        .from("ml_anuncios")
        .upsert(anuncios, { onConflict: "conta,item_id" });
      if (errUpsert) {
        resultado[conta.conta] = { erro: "falha ao salvar anúncios", detalhe: errUpsert };
        continue;
      }
    }

    // LIMPEZA DOS FANTASMAS.
    //
    // Anúncio apagado no Mercado Livre não sumia daqui: esta rotina só regravava o que
    // existe, nunca apagava o que deixou de existir. O resultado era anúncio morto
    // aparecendo em "Estoque parado" e em "Chegou mercadoria", e o robô tentando
    // desligar o Flex de página que nem abre mais (13 tentativas numa válvula PCV da
    // LTS em 11/09/2026, antes de o Matheus contar que tinha apagado o anúncio).
    //
    // Como a passada toca TODO anúncio vivo da conta, quem ficou com carimbo velho não
    // existe mais. As duas travas abaixo são o que separa "o anúncio morreu" de "a
    // passada é que veio capenga" — e apagar por engano custaria caro.
    let limpeza: unknown = "passada parcial — não limpei";
    const passadaCompleta =
      limite === 0 &&                             // com limite a passada é parcial de propósito
      idsTotal.length > 0 &&
      anuncios.length >= idsTotal.length * 0.9;   // detalhou quase tudo que listou

    if (passadaCompleta) {
      // OLHA ANTES DE APAGAR. As travas acima comparam a passada com ela mesma: se o
      // scan do ML devolvesse metade dos anúncios da conta, os 0,9 continuariam batendo
      // e a outra metade — viva — seria apagada. Esta trava compara com o que JÁ estava
      // no catálogo, que é a única testemunha independente que temos.
      const { data: velhos } = await supabase
        .from("ml_anuncios").select("item_id")
        .eq("conta", conta.conta).lt("atualizado_em", marcoDaPassada);
      const sumidos = velhos ?? [];
      const { count: totalNoCatalogo } = await supabase
        .from("ml_anuncios").select("item_id", { count: "exact", head: true })
        .eq("conta", conta.conta);

      const demaisPraSerVerdade = sumidos.length > Math.max(20, (totalNoCatalogo ?? 0) * 0.05);
      if (!sumidos.length) {
        limpeza = 0;
      } else if (demaisPraSerVerdade) {
        // Ninguém apaga 5% do catálogo num dia. Isso é falha do ML ou desta rotina —
        // e catálogo sobrando conserta sozinho na próxima passada, catálogo apagado não.
        limpeza = `${sumidos.length} anúncios sumiram de uma vez — não apaguei, confira à mão`;
      } else {
        const { data: apagados } = await supabase
          .from("ml_anuncios").delete()
          .eq("conta", conta.conta).lt("atualizado_em", marcoDaPassada)
          .select("item_id");
        limpeza = apagados?.length ?? 0;
      }
    }

    resultado[conta.conta] = {
      total_anuncios_conta: idsTotal.length,
      catalogados_agora: anuncios.length,
      removidos_por_nao_existirem_mais: limpeza,
    };
  }

  return new Response(JSON.stringify(resultado, null, 2), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
