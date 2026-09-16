// Aba "Análise" — diagnóstico dos anúncios ATIVOS, uma loja por vez.
//
// Duas fontes:
//   1. O checklist de qualidade do próprio Mercado Livre (GET /item/{id}/performance):
//      nota 0-100 + o que ele diz que está pendente.
//   2. As regras da casa, que vão além da nota (Matheus, 16/09/2026 — "melhorar o
//      anúncio como um todo pra ter mais visibilidade, mais conversão"):
//        - no mínimo 7 fotos;
//        - Número de peça com pelo menos 3 códigos;
//        - Código OEM com pelo menos 3 itens;
//        - nenhuma característica visível vazia (valor ou "Não se aplica");
//        - compatibilidade que cubra os modelos citados no título (a tela compara);
//        - visitas e vendas: visita e não vende, visitas caindo, sem visita (a tela julga).
//      Esta função só COLETA os números; os limites ficam na tela, num lugar só.
//
// Ações (POST):
//   { acao: "lote", conta, offset, limite }  analisa um pedaço e grava em ml_analise.
//   { acao: "fim", conta, inicio }           apaga o que não é mais ativo.
//   { acao: "aplicar", conta, item_id, atributos }  grava características escolhidas
//        ({id, value_id?, value_name?} — value_id "-1" = "Não se aplica").
//
// Regras combinadas: TÍTULO FORA; texto da descrição fora; promoção, Product Ads e preço
// são do Matheus; o resto do Leonardo; clip vira aviso pra Letícia.

import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
const API = "https://api.mercadolibre.com";

const IGNORAR = new Set(["UP_TITLE"]);
// Preço também fica com o Matheus: é decisão comercial, igual promoção.
const DO_MATHEUS = new Set(["UP_PROMOTIONS", "UP_ADS", "UP_PRICE"]);
const NOMES: Record<string, string> = {
  UP_PICTURES: "Fotos",
  UP_SHORTS: "Clip (avisar Letícia)",
  UP_COMPATS: "Compatibilidade",
  UP_TECHNICAL_SPECIFICATIONS_MAIN: "Ficha técnica",
  UP_GTIN: "Código universal (GTIN)",
  UP_STOCK_DEPOSITO: "Estoque baixo",
  UP_STOCK_AVAILABILITY_TIME: "Prazo de disponibilidade",
  UP_FREE_SHIPPING: "Frete grátis",
  UP_FINANCING: "Parcelamento sem juros",
  UP_ME_FLEX_ITEM_OPTIN: "Envios Flex",
  UP_PROMOTIONS: "Promoção",
  UP_ADS: "Product Ads",
  UP_PRICE: "Preço perdendo exposição",
};
const dono = (k: string) => k === "UP_SHORTS" ? "Letícia" : DO_MATHEUS.has(k) ? "Matheus" : "Leonardo";

// Campos que o vendedor não preenche (ou que ficam fora da tela do ML).
const NAO_SAO_CARACTERISTICA = new Set(["SELLER_SKU", "GTIN", "ITEM_CONDITION", "EMPTY_GTIN_REASON"]);

async function token(conta: string) {
  const { data } = await sb.from("ml_tokens").select("access_token, user_id").eq("conta", conta).maybeSingle();
  if (!data) throw new Error(`conta ${conta} sem token`);
  return { h: { Authorization: `Bearer ${data.access_token}` }, userId: data.user_id };
}

async function lerJson(url: string, h: HeadersInit) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: h });
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) return null;
    } catch (_e) { /* tenta de novo */ }
    await new Promise((ok) => setTimeout(ok, 800 * (i + 1)));
  }
  return null;
}

type Attr = { id: string; name?: string; value_id?: string | null; value_name?: string | null; values?: { name?: string | null }[]; tags?: Record<string, boolean> };

// Sugestão: o MESMO produto (mesmo SKU) em outro anúncio nosso com o campo preenchido.
// Não inventa valor — se ninguém tem, a tela oferece só "Não se aplica".
async function sugestoesDoIrmao(itemId: string, sku: string | null, ids: string[], cache: Map<string, Attr[][]>) {
  const saida: Record<string, { value_id: string | null; value_name: string; de: string }> = {};
  if (!sku || !ids.length) return saida;
  if (!cache.has(sku)) {
    const { data: irmaos } = await sb.from("ml_anuncios").select("conta, item_id")
      .eq("sku", sku).neq("item_id", itemId).limit(4);
    const lidos: Attr[][] = [];
    for (const irm of irmaos ?? []) {
      const t = await token(irm.conta).catch(() => null);
      if (!t) continue;
      const d = await lerJson(`${API}/items/${irm.item_id}?attributes=id,attributes`, t.h);
      if (d) lidos.push((d.attributes ?? []).map((a: Attr) => ({ ...a, de: d.id })));
    }
    cache.set(sku, lidos);
  }
  for (const id of ids) for (const attrs of cache.get(sku)!) {
    const a = attrs.find((x) => x.id === id && x.value_name && x.value_id !== "-1") as Attr & { de: string } | undefined;
    if (a) { saida[id] = { value_id: a.value_id ?? null, value_name: a.value_name!, de: a.de }; break; }
  }
  return saida;
}

const contarCodigos = (texto: string | null | undefined) =>
  String(texto ?? "").split(/[\s,;/|]+/).filter((p) => /\d/.test(p)).length;

async function analisarUm(a: Record<string, unknown>, t: { h: HeadersInit; userId: string },
  cacheIrmaos: Map<string, Attr[][]>, cacheCategoria: Map<string, Attr[]>) {
  const id = a.item_id as string;
  const h = t.h;
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const [perf, item, vis, compat, pedidos] = await Promise.all([
    lerJson(`${API}/item/${id}/performance`, h),
    lerJson(`${API}/items/${id}?include_attributes=all`, h),
    lerJson(`${API}/items/${id}/visits/time_window?last=30&unit=day`, h),
    lerJson(`${API}/items/${id}/compatibilities`, h),
    lerJson(`${API}/orders/search?seller=${t.userId}&item=${id}&order.date_created.from=${desde}&limit=1`, h),
  ]);
  if (!perf || !item) return null;

  const pendencias: unknown[] = [];
  for (const b of perf.buckets ?? []) for (const v of b.variables ?? []) {
    if (v.status !== "PENDING" || IGNORAR.has(v.key)) continue;
    pendencias.push({ key: v.key, nome: NOMES[v.key] ?? v.title, dica: v.title, dono: dono(v.key) });
  }

  // Características visíveis da categoria que o anúncio não tem preenchidas.
  const cat = item.category_id as string;
  if (!cacheCategoria.has(cat)) cacheCategoria.set(cat, (await lerJson(`${API}/categories/${cat}/attributes`, h)) ?? []);
  const doItem = new Map((item.attributes as Attr[]).map((x) => [x.id, x]));
  const vaziasIds = cacheCategoria.get(cat)!.filter((c) => {
    const tg = c.tags ?? {};
    if (tg.hidden || tg.read_only || tg.fixed || tg.variation_attribute || NAO_SAO_CARACTERISTICA.has(c.id)) return false;
    const x = doItem.get(c.id);
    return !x || (!x.value_name && !x.value_id);
  });
  const sug = await sugestoesDoIrmao(id, a.sku as string | null, vaziasIds.map((c) => c.id), cacheIrmaos);
  const vazias = vaziasIds.map((c) => ({ id: c.id, nome: c.name, sugestao: sug[c.id] ?? null }));

  const oemCat = cacheCategoria.get(cat)!.some((c) => c.id === "OEM" && !(c.tags ?? {}).hidden);
  const oem = doItem.get("OEM");

  // Visitas: total dos 15 dias mais recentes contra os 15 anteriores.
  // Separa pela DATA, não pela posição: dia sem visita não vem na resposta.
  const dias = (vis?.results ?? []) as { date: string; total: number }[];
  const corte = new Date(new Date(vis?.date_to ?? Date.now()).getTime() - 15 * 864e5).toISOString();
  const soma = (l: { total: number }[]) => l.reduce((s, d) => s + (d.total ?? 0), 0);
  const recentes = dias.filter((d) => d.date >= corte), anteriores = dias.filter((d) => d.date < corte);

  // Modelo = segunda palavra do nome do veículo no catálogo ("Volkswagen Gol 2010 ...").
  const modelos = [...new Set(((compat?.products ?? []) as { catalog_product_name?: string }[])
    .map((p) => String(p.catalog_product_name ?? "").split(" ")[1]).filter(Boolean))];

  return {
    conta: a.conta, item_id: id, title: item.title ?? a.title, sku: a.sku, marca: a.marca, no_full: a.no_full,
    nota: Math.round(perf.score ?? 0),
    pendencias,
    vazias,
    fotos: (item.pictures ?? []).length,
    codigos_peca: contarCodigos(doItem.get("PART_NUMBER")?.value_name),
    oem: oemCat ? (oem?.value_id === "-1" ? null : (oem?.values ?? []).filter((v) => v.name).length) : null,
    modelos,
    visitas_30: vis?.total_visits ?? 0,
    visitas_15: soma(recentes),
    visitas_15_antes: soma(anteriores),
    pedidos_30: pedidos?.paging?.total ?? 0,
    vendidos: item.sold_quantity ?? 0,
    // colunas da primeira versão, mantidas vazias
    faltam_atributos: [], sugestao: [],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const c = await req.json();
    const conta = String(c.conta ?? "").toUpperCase();
    if (!["KMP", "ERP", "LTS"].includes(conta)) return json({ erro: "loja inválida" }, 400);

    if (c.acao === "lote") {
      const offset = Number(c.offset ?? 0), limite = Math.min(Number(c.limite ?? 15), 25);
      const { data: ativos, count } = await sb.from("ml_anuncios")
        .select("conta, item_id, title, sku, marca, no_full", { count: "exact" })
        .eq("conta", conta).eq("status", "active").order("item_id").range(offset, offset + limite - 1);
      const t = await token(conta);
      const cacheIrmaos = new Map(), cacheCategoria = new Map();
      const linhas = (await Promise.all((ativos ?? []).map((a) => analisarUm(a, t, cacheIrmaos, cacheCategoria))))
        .filter(Boolean) as Record<string, unknown>[];

      // "Feito" só vale até a próxima análise: o que o ML reconheceu some sozinho, o que
      // ainda falta volta.
      const agora = new Date().toISOString();
      for (const l of linhas) { l.feito = {}; l.analisado_em = agora; }
      if (linhas.length) {
        const { error } = await sb.from("ml_analise").upsert(linhas, { onConflict: "conta,item_id" });
        if (error) throw new Error(error.message);
      }
      return json({ processados: (ativos ?? []).length, total: count ?? 0, gravados: linhas.length });
    }

    if (c.acao === "fim") {
      await sb.from("ml_analise").delete().eq("conta", conta).lt("analisado_em", c.inicio);
      return json({ ok: true });
    }

    if (c.acao === "aplicar") {
      const atributos = (c.atributos ?? []).map((a: Attr) =>
        a.value_id === "-1" ? { id: a.id, value_id: "-1", value_name: null }
          : a.value_id ? { id: a.id, value_id: a.value_id } : { id: a.id, value_name: a.value_name });
      if (!c.item_id || !atributos.length) return json({ erro: "nada pra aplicar" }, 400);
      const t = await token(conta);
      const r = await fetch(`${API}/items/${c.item_id}`, {
        method: "PUT", headers: { ...t.h, "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: atributos }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        const motivo = [corpo.message, ...(corpo.cause ?? []).map((x: { message?: string }) => x.message)]
          .filter(Boolean).join(" · ").slice(0, 300) || `o ML respondeu ${r.status}`;
        await sb.from("ml_log_acoes").insert({ conta, item_id: c.item_id, acao: "falhou", origem: "site",
          detalhe: `análise — características: ${motivo}` }).then(() => {}, () => {});
        return json({ ok: false, motivo });
      }
      // Confere no ML, em vez de confiar no 200: relê as características gravadas.
      const depois = await lerJson(`${API}/items/${c.item_id}?attributes=id,attributes`, t.h);
      const gravou = new Set(((depois?.attributes ?? []) as Attr[])
        .filter((x) => x.value_name || x.value_id).map((x) => x.id));
      const aplicados = atributos.map((a: Attr) => a.id);
      const naoPegou = aplicados.filter((id: string) => !gravou.has(id));

      const { data: linha } = await sb.from("ml_analise").select("vazias").eq("conta", conta).eq("item_id", c.item_id).maybeSingle();
      if (linha) {
        await sb.from("ml_analise").update({
          vazias: (linha.vazias ?? []).filter((v: { id: string }) => !aplicados.includes(v.id) || naoPegou.includes(v.id)),
        }).eq("conta", conta).eq("item_id", c.item_id);
      }
      await sb.from("ml_log_acoes").insert({ conta, item_id: c.item_id, title: corpo.title ?? null, acao: "ficha_tecnica",
        origem: "site", detalhe: `análise — características: ${aplicados.join(", ")}` }).then(() => {}, () => {});
      return json({ ok: naoPegou.length === 0, nao_pegou: naoPegou,
        motivo: naoPegou.length ? `o ML aceitou mas não gravou: ${naoPegou.join(", ")}` : undefined });
    }

    return json({ erro: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
