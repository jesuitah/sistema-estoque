import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DESCRICAO_PADRAO = `=========================IMPORTANTE=========================

Confirme os dados do seu veículo como ANO / MODELO / MOTORIZAÇÃO nos campos de comentários antes de realizar a compra. Dessa forma evitamos o transtorno de PEÇAS INCORRETAS / DEVOLUÇÕES.

=========================IMPORTANTE=========================

VANTAGENS DE COMPRAR CONOSCO:

- Frete com ENVIO IMEDIATO FULL para todo o Brasil. (Chega muito mais rápido que o frete convencional).
- MODELO TOP DE LINHA, PRONTA ENTREGA.
- Parcelamento sem juros com o melhor preço!
- Nota Fiscal

=========================IMPORTANTE=========================

APLICAÇÕES:


•


--------------------------------------------------------------------------------

CÓDIGOS DE REFERÊNCIA:

ORIGINAL

--------------------------------------------------------------------------------

CONTEÚDO DA CAIXA:

01 -

NÃO ACHOU O QUE PROCURAVA? FAÇA UMA PERGUNTA, NOSSA EQUIPE TERÁ UMA SOLUÇÃO IDEAL PARA VOCÊ!
_____________________________________________________________

O Produto pode ser retirado em Santo André – SP
Atenciosamente, Central de Atendimento :D`;

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

async function obterTokenConta(supabase: any, contaNome: string): Promise<string> {
  const { data: conta, error } = await supabase.from("ml_tokens").select("*").eq("conta", contaNome).single();
  if (error || !conta) throw new Error("Conta não encontrada: " + contaNome);
  let accessToken = conta.access_token;
  const expiraEm = new Date(conta.expires_at).getTime() - Date.now();
  if (expiraEm < 10 * 60 * 1000) {
    const novo = await renovarToken(supabase, conta);
    if (novo) accessToken = novo;
  }
  return accessToken;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  const acao = url.searchParams.get("acao");

  try {
    // --- Sugerir categoria a partir do título ---
    if (req.method === "GET" && acao === "sugerir_categoria") {
      const titulo = url.searchParams.get("titulo") || "";
      const conta = url.searchParams.get("conta") || "KMP";
      const token = await obterTokenConta(supabase, conta);
      const resp = await fetch(
        `https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${encodeURIComponent(titulo)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await resp.json();
      if (!resp.ok) return new Response(JSON.stringify({ erro: "Falha ao sugerir categoria", detalhe: data }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // --- Buscar atributos obrigatórios de uma categoria ---
    if (req.method === "GET" && acao === "atributos") {
      const categoriaId = url.searchParams.get("categoria_id") || "";
      const conta = url.searchParams.get("conta") || "KMP";
      const token = await obterTokenConta(supabase, conta);
      const resp = await fetch(`https://api.mercadolibre.com/categories/${categoriaId}/attributes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      if (!resp.ok) return new Response(JSON.stringify({ erro: "Falha ao buscar atributos", detalhe: data }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
      // Obrigatórios + os que o comprador vê (preencher sobe a nota de qualidade).
      // Fora: o que o ML esconde/trava e o que o sistema já preenche sozinho.
      const JA_PREENCHIDOS = new Set(["SELLER_SKU", "ITEM_CONDITION", "GTIN", "EMPTY_GTIN_REASON",
        "SELLER_PACKAGE_LENGTH", "SELLER_PACKAGE_WIDTH", "SELLER_PACKAGE_HEIGHT", "SELLER_PACKAGE_WEIGHT",
        "SELLER_PACKAGE_TYPE"]);
      const lista = (data as any[])
        .filter((a) => {
          const tg = a.tags || {};
          if (JA_PREENCHIDOS.has(a.id)) return false;
          if (tg.required) return true;
          return !(tg.hidden || tg.read_only || tg.fixed || tg.others || tg.variation_attribute || tg.allow_variations);
        })
        .map((a) => ({
          id: a.id,
          nome: a.name,
          obrigatorio: !!a.tags?.required,
          tipo: a.value_type,
          unidade: a.default_unit || null,
          valores: (a.values || []).map((v: any) => ({ id: v.id, nome: v.name })),
        }))
        .sort((x, y) => Number(y.obrigatorio) - Number(x.obrigatorio));
      return new Response(JSON.stringify(lista), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // --- Dados de uma categoria (nome + caminho completo), pra escolher pelo código ---
    if (req.method === "GET" && acao === "categoria") {
      const id = (url.searchParams.get("categoria_id") || "").trim().toUpperCase();
      const resp = await fetch(`https://api.mercadolibre.com/categories/${encodeURIComponent(id)}`);
      const data = await resp.json();
      if (!resp.ok) return new Response(JSON.stringify({ erro: "Categoria não encontrada" }), { status: 404, headers: { "Content-Type": "application/json", ...CORS } });
      return new Response(JSON.stringify({
        category_id: data.id,
        category_name: data.name,
        caminho: (data.path_from_root || []).map((p: any) => p.name).join(" > "),
        folha: !(data.children_categories || []).length,
        filhas: (data.children_categories || []).map((f: any) => ({ category_id: f.id, category_name: f.name })),
      }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // --- Texto padrão da descrição (o cartão mostra pra editar antes de criar) ---
    if (req.method === "GET" && acao === "descricao_padrao") {
      return new Response(JSON.stringify({ texto: DESCRICAO_PADRAO }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // --- Já existe anúncio com esse SKU nessa loja? ---
    if (req.method === "GET" && acao === "duplicado") {
      const conta = url.searchParams.get("conta") || "KMP";
      const sku = url.searchParams.get("sku") || "";
      const token = await obterTokenConta(supabase, conta);
      const { data: tk } = await supabase.from("ml_tokens").select("user_id").eq("conta", conta).single();
      const resp = await fetch(
        `https://api.mercadolibre.com/users/${tk.user_id}/items/search?seller_sku=${encodeURIComponent(sku)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await resp.json();
      return new Response(JSON.stringify({ itens: resp.ok ? (data.results || []) : [] }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // --- Upload de uma foto (multipart/form-data com campo 'file') ---
    if (req.method === "POST" && acao === "upload_foto") {
      const conta = url.searchParams.get("conta") || "KMP";
      const token = await obterTokenConta(supabase, conta);
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file) return new Response(JSON.stringify({ erro: "Nenhum arquivo enviado" }), { status: 400, headers: { "Content-Type": "application/json", ...CORS } });

      const uploadForm = new FormData();
      uploadForm.append("file", file as File);
      const resp = await fetch("https://api.mercadolibre.com/pictures/items/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: uploadForm,
      });
      const data = await resp.json();
      if (!resp.ok) return new Response(JSON.stringify({ erro: "Falha no upload da foto", detalhe: data }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
      return new Response(JSON.stringify({ picture_id: data.id }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // --- Criar o anúncio (já nasce ativo, pausamos em seguida) ---
    if (req.method === "POST" && acao === "criar") {
      const body = await req.json();
      const { conta, titulo, categoria_id, preco, quantidade, sku, atributos, picture_ids, comprimento, largura, altura, peso, descricao, compat_ids } = body;
      const token = await obterTokenConta(supabase, conta);

      // Fotos de template da loja (mesma lógica da clonagem): busca fresca do anúncio de
      // referência e usa as últimas N fotos dele, coladas depois das fotos reais do produto.
      let fotosTemplate: { source: string }[] = [];
      const { data: template } = await supabase
        .from("ml_templates_fotos")
        .select("*")
        .eq("conta", conta)
        .maybeSingle();
      if (template) {
        const respRef = await fetch(`https://api.mercadolibre.com/items/${template.item_id_referencia}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (respRef.ok) {
          const ref = await respRef.json();
          fotosTemplate = (ref.pictures || []).slice(-template.qtd_fotos_template).map((p: any) => ({ source: p.secure_url }));
        }
      }

      const fotosProduto = (picture_ids || []).map((id: string) => ({ id }));
      const fotosFinal = fotosProduto.concat(fotosTemplate);

      const atributosFinal = [
        ...(atributos || []).map((a: any) => ({ id: a.id, value_name: a.value_name, ...(a.value_id ? { value_id: a.value_id } : {}) })),
        ...(sku ? [{ id: "SELLER_SKU", value_name: sku }] : []),
      ];

      // Dimensões da embalagem (obrigatório pro ML calcular frete): atributos number_unit,
      // aceitos como texto "número unidade" (ex: "23 cm") — testado e confirmado.
      if (comprimento) atributosFinal.push({ id: "SELLER_PACKAGE_LENGTH", value_name: `${comprimento} cm` });
      if (largura) atributosFinal.push({ id: "SELLER_PACKAGE_WIDTH", value_name: `${largura} cm` });
      if (altura) atributosFinal.push({ id: "SELLER_PACKAGE_HEIGHT", value_name: `${altura} cm` });
      if (peso) atributosFinal.push({ id: "SELLER_PACKAGE_WEIGHT", value_name: `${peso} g` });

      const itemBody: any = {
        family_name: titulo,
        category_id: categoria_id,
        price: preco,
        currency_id: "BRL",
        available_quantity: quantidade,
        buying_mode: "buy_it_now",
        condition: "new",
        listing_type_id: "gold_pro", // Premium (padrão da empresa)
        pictures: fotosFinal,
        attributes: atributosFinal,
        shipping: { local_pick_up: true },
        sale_terms: [
          { id: "WARRANTY_TYPE", value_id: "2230280", value_name: "Garantia do vendedor" },
          { id: "WARRANTY_TIME", value_name: "3 meses" },
        ],
      };

      const respCriar = await fetch("https://api.mercadolibre.com/items", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(itemBody),
      });
      const novo = await respCriar.json();
      if (!respCriar.ok) {
        return new Response(JSON.stringify({ erro: "Falha ao criar anúncio", detalhe: novo }), { status: 400, headers: { "Content-Type": "application/json", ...CORS } });
      }

      // Pausa logo de cara: só vai pro ar quando ele ativar no ML.
      await fetch(`https://api.mercadolibre.com/items/${novo.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paused" }),
      });

      // Descrição: a que ele completou no cartão (aplicações, códigos, conteúdo da caixa).
      const respDesc = await fetch(`https://api.mercadolibre.com/items/${novo.id}/description`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ plain_text: (descricao && String(descricao).trim()) ? descricao : DESCRICAO_PADRAO }),
      });
      const avisos: string[] = [];
      if (!respDesc.ok) avisos.push("descrição não foi gravada");

      // Compatibilidade: tenta no item; se o ML pedir, vai pelo user-product (igual à clonagem).
      let compatSalvas = 0;
      const produtos = [...new Set((compat_ids || []) as string[])].map((id) => ({ id }));
      for (let i = 0; i < produtos.length; i += 200) {
        const lote = produtos.slice(i, i + 200);
        const r1 = await fetch(`https://api.mercadolibre.com/items/${novo.id}/compatibilities`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ products: lote }),
        });
        const d1 = await r1.json().catch(() => ({}));
        if (r1.ok) { compatSalvas += d1.created_compatibilities_count ?? lote.length; continue; }
        if (novo.user_product_id) {
          const r2 = await fetch(`https://api.mercadolibre.com/user-products/${novo.user_product_id}/compatibilities`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ domain_id: "MLB-CARS_AND_VANS", products: lote }),
          });
          const d2 = await r2.json().catch(() => ({}));
          if (r2.ok) { compatSalvas += d2.created_compatibilities_count ?? lote.length; continue; }
        }
        avisos.push("compatibilidade: " + (d1.message || "o ML recusou"));
      }

      return new Response(JSON.stringify({ item_id: novo.id, permalink: novo.permalink, fotos: fotosFinal.length, compat: compatSalvas, avisos }), { headers: { "Content-Type": "application/json", ...CORS } });
    }

    return new Response(JSON.stringify({ erro: "Ação inválida" }), { status: 400, headers: { "Content-Type": "application/json", ...CORS } });
  } catch (e) {
    return new Response(JSON.stringify({ erro: "Erro inesperado", detalhe: String(e) }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
  }
});
