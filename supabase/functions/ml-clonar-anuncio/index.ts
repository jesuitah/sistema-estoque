import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Atributos que NÃO podem ser copiados pro anúncio novo.
//
// - INMETRO: registro oficial validado contra um cadastro que pertence só ao anúncio
//   original; travava a criação com `invalid_sanitary_registry_value`.
// - Os demais: o próprio ML respondeu "ignored because it is not modifiable" pra cada
//   um deles. Mandar não adianta nada e só polui o payload.
//   (atenção: PACKAGE_* não é a mesma coisa que SELLER_PACKAGE_* — esses últimos SÃO
//   aceitos e são obrigatórios pro cálculo de frete, então continuam sendo copiados.)
const ATRIBUTOS_NAO_COPIAVEIS = [
  "INMETRO_CERTIFICATION_REGISTRATION_NUMBER",
  "CATALOG_TITLE",
  "GTIN",
  "HAS_COMPATIBILITIES",
  "PACKAGE_HEIGHT",
  "PACKAGE_LENGTH",
  "PACKAGE_WEIGHT",
  "PACKAGE_WIDTH",
  "PRODUCT_FEATURES",
  "SHIPMENT_PACKING",
];

// Condições de venda ligadas a PROMOÇÃO/DESCONTO não podem ser copiadas: elas
// pertencem à campanha do anúncio de origem. Tentar criar um anúncio novo já com o
// desconto de outro faz o ML recusar com `sale_term.not_allowed`.
//
// Caso real que motivou isso: anúncio da KMP com ALL_METHODS_REBATE_PRICE (preço
// promocional de R$ 65) não clonava pra ERP, enquanto anúncios sem promoção clonavam
// normalmente. Garantia (WARRANTY_TYPE / WARRANTY_TIME) continua sendo copiada.
function termoDeVendaCopiavel(id: string): boolean {
  return !/REBATE|DISCOUNT|PROMO/i.test(String(id || ""));
}

// ATRIBUTO QUE A CATEGORIA NÃO CONHECE NÃO VIAJA.
//
// Um anúncio pode carregar atributos que a categoria dele não define — restos de
// quando foi criado, de outra categoria, ou de um cadastro que o ML mudou depois. Eles
// ficam parados no anúncio de origem sem incomodar ninguém, mas na hora de criar um
// anúncio NOVO o ML valida cada um contra a categoria e recusa a criação inteira.
//
// Caso real: as mangueiras da HJ pararam de clonar com
//   "Attribute HOSE_POSITION is not a valid number".
// O dado do próprio ML é contraditório — HOSE_POSITION vem com value_type "integer" e
// valor "Superior" — mas a raiz é outra: a categoria MLB193398 tem 69 atributos e
// HOSE_POSITION não é um deles. Junto vinham INCLUDES_HOSES_CLAMPS, SALE_FORMAT,
// SELLER_PACKAGE_TYPE e UNITS_PER_PACK, todos forasteiros.
//
// Tirar os forasteiros resolve e é uma regra geral: vale pra qualquer atributo órfão
// que apareça no futuro, sem precisar de uma lista nova a cada erro.
async function atributosDaCategoria(categoryId: string): Promise<Set<string> | null> {
  try {
    const r = await fetch(`https://api.mercadolibre.com/categories/${categoryId}/attributes`);
    if (!r.ok) return null;
    const lista = await r.json();
    if (!Array.isArray(lista) || !lista.length) return null;
    return new Set(lista.map((a: any) => a.id));
  } catch (_e) {
    // Sem resposta do ML, não filtra nada: é melhor tentar criar com tudo (o
    // comportamento antigo, que funciona na maioria) do que jogar fora atributo bom.
    return null;
  }
}

function erroJson(mensagem: string, status: number, detalhe?: unknown) {
  return new Response(JSON.stringify({ erro: mensagem, detalhe: detalhe ?? null }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

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

async function tokenValido(supabase: any, conta: string): Promise<string | null> {
  const { data } = await supabase.from("ml_tokens").select("*").eq("conta", conta).maybeSingle();
  if (!data) return null;
  let accessToken = data.access_token;
  const expiraEm = new Date(data.expires_at).getTime() - Date.now();
  if (expiraEm < 10 * 60 * 1000) {
    const novo = await renovarToken(supabase, data);
    if (novo) accessToken = novo;
  }
  return accessToken;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return erroJson("Corpo da requisição inválido.", 400);
  }

  const { conta_origem, item_id_origem, conta_destino, unidades } = body;
  if (!conta_origem || !item_id_origem || !conta_destino) {
    return erroJson("Faltam parâmetros: conta_origem, item_id_origem, conta_destino.", 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const tokenOrigem = await tokenValido(supabase, conta_origem);
  const tokenDestino = await tokenValido(supabase, conta_destino);
  if (!tokenOrigem) return erroJson(`Conta de origem (${conta_origem}) sem token válido.`, 400);
  if (!tokenDestino) return erroJson(`Conta de destino (${conta_destino}) sem token válido.`, 400);

  const { data: templateDestino } = await supabase
    .from("ml_templates_fotos")
    .select("*")
    .eq("conta", conta_destino)
    .maybeSingle();
  const { data: templateOrigem } = await supabase
    .from("ml_templates_fotos")
    .select("*")
    .eq("conta", conta_origem)
    .maybeSingle();
  if (!templateDestino || !templateOrigem) {
    return erroJson("Falta cadastrar o anúncio de referência de fotos (template) de uma das contas.", 400);
  }

  // 1) Item de origem completo
  const respOrigem = await fetch(`https://api.mercadolibre.com/items/${item_id_origem}`, {
    headers: { Authorization: `Bearer ${tokenOrigem}` },
  });
  const origem = await respOrigem.json();
  if (!respOrigem.ok) return erroJson("Falha ao buscar o anúncio de origem.", 400, origem);

  // 2) Descrição da origem
  const respDescOrigem = await fetch(`https://api.mercadolibre.com/items/${item_id_origem}/description`, {
    headers: { Authorization: `Bearer ${tokenOrigem}` },
  });
  const descOrigem = respDescOrigem.ok ? await respDescOrigem.json() : { plain_text: null };

  // 3) Compatibilidades da origem
  const respCompatOrigem = await fetch(`https://api.mercadolibre.com/items/${item_id_origem}/compatibilities`, {
    headers: { Authorization: `Bearer ${tokenOrigem}` },
  });
  const compatOrigem = respCompatOrigem.ok ? await respCompatOrigem.json() : { products: [] };

  // 4) Fotos de template do destino (busca fresca do anúncio de referência)
  const respRefDestino = await fetch(`https://api.mercadolibre.com/items/${templateDestino.item_id_referencia}`, {
    headers: { Authorization: `Bearer ${tokenDestino}` },
  });
  const refDestino = await respRefDestino.json();
  if (!respRefDestino.ok) return erroJson("Falha ao buscar o anúncio de referência de fotos do destino.", 400, refDestino);
  const fotosTemplateDestino = (refDestino.pictures || []).slice(-templateDestino.qtd_fotos_template);

  // 5) Monta lista final de fotos: reais da origem (sem o template dela) + template do destino
  const fotosOrigem = origem.pictures || [];
  const fotosReaisOrigem = fotosOrigem.slice(0, Math.max(0, fotosOrigem.length - templateOrigem.qtd_fotos_template));
  const fotosFinal = fotosReaisOrigem.concat(fotosTemplateDestino).map((p: any) => ({ source: p.secure_url }));

  // 6) Atributos filtrados
  const daCategoria = await atributosDaCategoria(origem.category_id);
  const adiados: any[] = [];
  const atributos = (origem.attributes || [])
    .filter((a: any) => {
      if (ATRIBUTOS_NAO_COPIAVEIS.indexOf(a.id) !== -1) return false;
      // SELLER_SKU é nosso, não do catálogo do ML: passa sempre.
      if (a.id === "SELLER_SKU") return true;
      const vazio = (a.value_id === "-1" || a.value_id === null) && !a.value_name;
      if (vazio) return false;
      // Fora da categoria: não vai na CRIAÇÃO, mas é tentado depois (passo 8b).
      if (daCategoria && !daCategoria.has(a.id)) { adiados.push(a); return false; }
      return true;
    })
    .map((a: any) => {
      const obj: any = { id: a.id, value_name: a.value_name };
      if (a.value_id && a.value_id !== "-1") obj.value_id = a.value_id;
      return obj;
    });

  const quantidadeFinal = typeof unidades === "number" ? unidades : (origem.available_quantity ?? 1);

  const termosDeVenda = (origem.sale_terms || [])
    .filter((s: any) => termoDeVendaCopiavel(s.id))
    .map((s: any) => ({ id: s.id, value_name: s.value_name }));

  const novoCorpo = {
    family_name: origem.family_name,
    category_id: origem.category_id,
    price: origem.price,
    currency_id: origem.currency_id,
    available_quantity: quantidadeFinal,
    buying_mode: "buy_it_now",
    condition: origem.condition,
    listing_type_id: origem.listing_type_id,
    pictures: fotosFinal,
    attributes: atributos,
    sale_terms: termosDeVenda,
    shipping: { mode: origem.shipping?.mode ?? "me2" },
  };

  // 7) Cria o anúncio
  const respCriar = await fetch("https://api.mercadolibre.com/items", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenDestino}`, "Content-Type": "application/json" },
    body: JSON.stringify(novoCorpo),
  });
  const novo = await respCriar.json();
  if (!respCriar.ok) return erroJson("Falha ao criar o anúncio no Mercado Livre.", 400, novo);

  // 8) Pausa (a API não deixa criar já pausado)
  await fetch(`https://api.mercadolibre.com/items/${novo.id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tokenDestino}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "paused" }),
  });

  // 8b) DEVOLVE O QUE FICOU DE FORA DA CRIAÇÃO.
  //
  // O ML é mais rígido ao CRIAR do que ao EDITAR: um atributo que derruba a criação
  // inteira costuma ser aceito numa edição depois. Medido nas mangueiras da HJ — dos
  // 5 atributos que impediam a clonagem, 4 entraram sem reclamar por PUT:
  //   INCLUDES_HOSES_CLAMPS · SALE_FORMAT · SELLER_PACKAGE_TYPE · UNITS_PER_PACK ✅
  //   HOSE_POSITION ❌ (o dado do próprio ML é inválido: tipo "integer", valor "Superior")
  //
  // Isso importa porque ficha técnica cheia pontua melhor no Mercado Livre. Descartar
  // era o preço de conseguir criar; não precisa ser o preço final.
  //
  // Tenta todos de uma vez (1 chamada, o caso comum) e, se o lote cair por causa de um
  // ruim, tenta um a um pra não perder os bons junto com ele.
  const recuperados: string[] = [];
  const perdidos: string[] = [];
  if (adiados.length) {
    const put = (attrs: any[]) => fetch(`https://api.mercadolibre.com/items/${novo.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tokenDestino}`, "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: attrs }),
    });

    const paraEnviar = adiados.map((a: any) => {
      const obj: any = { id: a.id, value_name: a.value_name };
      if (a.value_id && a.value_id !== "-1") obj.value_id = a.value_id;
      return obj;
    });

    const emLote = await put(paraEnviar);
    if (emLote.ok) {
      recuperados.push(...paraEnviar.map((a: any) => a.id));
    } else {
      for (const attr of paraEnviar) {
        const r = await put([attr]);
        if (r.ok) { recuperados.push(attr.id); continue; }
        // Alguns só entram sem o value_id (o id não resolve nesta categoria).
        const semId = await put([{ id: attr.id, value_name: attr.value_name }]);
        if (semId.ok) recuperados.push(attr.id); else perdidos.push(attr.id);
      }
    }
  }

  // 9) Descrição
  if (descOrigem.plain_text) {
    await fetch(`https://api.mercadolibre.com/items/${novo.id}/description`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenDestino}`, "Content-Type": "application/json" },
      body: JSON.stringify({ plain_text: descOrigem.plain_text }),
    });
  }

  // 10) Compatibilidades: tenta no item; se der erro de "User Product", tenta no user-product
  const produtosCompat = (compatOrigem.products || [])
    .filter((p: any) => p.catalog_product_id)
    .map((p: any) => ({ id: p.catalog_product_id }));
  let compatibilidadesSalvas = 0;
  if (produtosCompat.length > 0) {
    const respCompat1 = await fetch(`https://api.mercadolibre.com/items/${novo.id}/compatibilities`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenDestino}`, "Content-Type": "application/json" },
      body: JSON.stringify({ products: produtosCompat }),
    });
    const dataCompat1 = await respCompat1.json();
    if (respCompat1.ok) {
      compatibilidadesSalvas = dataCompat1.created_compatibilities_count ?? produtosCompat.length;
    } else if (novo.user_product_id && /User Product/i.test(dataCompat1.message || "")) {
      const domainId = compatOrigem.products?.[0]?.domain_id || "MLB-CARS_AND_VANS";
      const respCompat2 = await fetch(`https://api.mercadolibre.com/user-products/${novo.user_product_id}/compatibilities`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenDestino}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain_id: domainId, products: produtosCompat }),
      });
      const dataCompat2 = await respCompat2.json();
      if (respCompat2.ok) compatibilidadesSalvas = dataCompat2.created_compatibilities_count ?? produtosCompat.length;
    }
  }

  // Atualiza o catálogo local pra esse gap já sumir da lista sem precisar recatalogar tudo
  // Lê o SKU da ORIGEM, não da lista já preparada pro envio: aquela pode ter trocado o
  // value_name por value_id, e o que interessa aqui é o texto.
  const skuAttr = (origem.attributes || []).find((a: any) => a.id === "SELLER_SKU");
  await supabase.from("ml_anuncios").upsert({
    conta: conta_destino,
    item_id: novo.id,
    title: novo.title,
    category_id: novo.category_id,
    price: novo.price,
    available_quantity: novo.available_quantity,
    marca: null,
    sku: null,
    seller_sku_bruto: skuAttr?.value_name ?? null,
    atualizado_em: new Date().toISOString(),
  }, { onConflict: "conta,item_id" });
  // marca/sku ficam null aqui de propósito (mesma regra do sincronizador: só o próximo
  // recatalogar oficial vai re-parsear certinho); o registro já aparece pra não duplicar depois.

  return new Response(JSON.stringify({
    item_id: novo.id,
    permalink: novo.permalink,
    status: novo.status,
    fotos: fotosFinal.length,
    compatibilidades: compatibilidadesSalvas,
    // Atributos que não couberam na criação: quais voltaram por edição e quais o ML
    // recusou de vez. Sai na resposta pra que uma clonagem que "deu certo mas veio
    // diferente" tenha explicação, em vez de virar mistério meses depois.
    atributos_recuperados: recuperados,
    atributos_perdidos: perdidos,
  }), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
