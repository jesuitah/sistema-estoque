// Aba "Análise" — diagnóstico dos anúncios ATIVOS, uma loja por vez.
//
// O critério não é nosso: é o checklist de qualidade que o próprio Mercado Livre
// devolve em GET /item/{id}/performance (nota 0-100 + o que está pendente). A ideia
// do Matheus é "ajudar o Mercado Livre a me ajudar": completar o que ele pede.
//
// Ações (POST):
//   { acao: "lote", conta, offset, limite }  analisa um pedaço e grava em ml_analise.
//                                            A tela chama em sequência até acabar —
//                                            uma chamada só não caberia no tempo limite.
//   { acao: "fim", conta, inicio }           apaga o que não é mais ativo (não foi
//                                            analisado nesta rodada).
//   { acao: "aplicar", conta, item_id, atributos }  grava a ficha técnica sugerida.
//
// Regras combinadas (15/09/2026):
//   - TÍTULO FORA: nunca analisar nem sugerir título.
//   - Promoção e Product Ads são do Matheus; o resto é do Leonardo; clip vira só aviso.
//   - Marcou "feito" e o ML continua dizendo pendente na próxima análise: volta pra lista.

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

async function token(conta: string) {
  const { data } = await sb.from("ml_tokens").select("access_token").eq("conta", conta).maybeSingle();
  if (!data) throw new Error(`conta ${conta} sem token`);
  return { Authorization: `Bearer ${data.access_token}` };
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

// Sugestão de ficha técnica: o MESMO produto (mesmo SKU) em outro anúncio nosso que
// já tem o campo preenchido. Não inventa valor — se ninguém tem, só aponta.
async function sugerir(item: { item_id: string; sku: string | null }, faltam: string[], h: HeadersInit,
  cache: Map<string, Record<string, unknown>[]>) {
  if (!item.sku || !faltam.length) return [];
  if (!cache.has(item.sku)) {
    const { data: irmaos } = await sb.from("ml_anuncios").select("conta, item_id")
      .eq("sku", item.sku).neq("item_id", item.item_id).limit(4);
    const lidos: Record<string, unknown>[] = [];
    for (const irm of irmaos ?? []) {
      const hi = await token(irm.conta).catch(() => h);
      const d = await lerJson(`${API}/items/${irm.item_id}?attributes=id,attributes`, hi);
      if (d) lidos.push(d);
    }
    cache.set(item.sku, lidos);
  }
  const sugestao: unknown[] = [];
  for (const id of faltam) {
    for (const irm of cache.get(item.sku)!) {
      const a = ((irm.attributes as Record<string, unknown>[]) ?? [])
        .find((x) => x.id === id && x.value_name);
      if (a) {
        sugestao.push({ id, nome: a.name, value_id: a.value_id ?? null, value_name: a.value_name, de: irm.id });
        break;
      }
    }
  }
  return sugestao;
}

async function analisarUm(a: Record<string, unknown>, h: HeadersInit, cache: Map<string, Record<string, unknown>[]>) {
  const id = a.item_id as string;
  const [perf, item, quali, vis] = await Promise.all([
    lerJson(`${API}/item/${id}/performance`, h),
    lerJson(`${API}/items/${id}?attributes=id,title,status,sold_quantity`, h),
    lerJson(`${API}/catalog_quality/status?item_id=${id}&v=3`, h),
    lerJson(`${API}/items/${id}/visits/time_window?last=30&unit=day`, h),
  ]);
  if (!perf) return null;

  const pendencias: unknown[] = [];
  for (const b of perf.buckets ?? []) for (const v of b.variables ?? []) {
    if (v.status !== "PENDING" || IGNORAR.has(v.key)) continue;
    pendencias.push({ key: v.key, nome: NOMES[v.key] ?? v.title, dica: v.title, dono: dono(v.key) });
  }
  const faltam: string[] = quali?.adoption_status?.all?.missing_attributes ?? [];
  return {
    conta: a.conta, item_id: id, title: item?.title ?? a.title, sku: a.sku, marca: a.marca, no_full: a.no_full,
    nota: Math.round(perf.score ?? 0),
    pendencias,
    faltam_atributos: faltam,
    sugestao: await sugerir({ item_id: id, sku: a.sku as string | null }, faltam, h, cache),
    visitas_30: vis?.total_visits ?? 0,
    vendidos: item?.sold_quantity ?? 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const c = await req.json();
    const conta = String(c.conta ?? "").toUpperCase();
    if (!["KMP", "ERP", "LTS"].includes(conta)) return json({ erro: "loja inválida" }, 400);

    if (c.acao === "lote") {
      const offset = Number(c.offset ?? 0), limite = Math.min(Number(c.limite ?? 25), 40);
      const { data: ativos, count } = await sb.from("ml_anuncios")
        .select("conta, item_id, title, sku, marca, no_full", { count: "exact" })
        .eq("conta", conta).eq("status", "active").order("item_id").range(offset, offset + limite - 1);
      const h = await token(conta);
      const cache = new Map();
      const linhas = (await Promise.all((ativos ?? []).map((a) => analisarUm(a, h, cache)))).filter(Boolean);

      // "Feito" só vale até a próxima análise, por isso ela zera as marcações: o que o
      // ML reconheceu some sozinho da lista, e o que ele ainda diz pendente volta.
      const agora = new Date().toISOString();
      for (const l of linhas as Record<string, unknown>[]) { l.feito = {}; l.analisado_em = agora; }
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
      const atributos = (c.atributos ?? []).map((a: Record<string, unknown>) =>
        a.value_id ? { id: a.id, value_id: a.value_id } : { id: a.id, value_name: a.value_name });
      if (!c.item_id || !atributos.length) return json({ erro: "nada pra aplicar" }, 400);
      const h = await token(conta);
      const r = await fetch(`${API}/items/${c.item_id}`, {
        method: "PUT", headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: atributos }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        const motivo = [corpo.message, ...(corpo.cause ?? []).map((x: { message?: string }) => x.message)]
          .filter(Boolean).join(" · ").slice(0, 300) || `o ML respondeu ${r.status}`;
        await sb.from("ml_log_acoes").insert({ conta, item_id: c.item_id, acao: "falhou", origem: "site",
          detalhe: `análise — ficha técnica: ${motivo}` }).then(() => {}, () => {});
        return json({ ok: false, motivo });
      }
      // Confere no ML o que ainda falta, em vez de confiar no 200.
      const quali = await lerJson(`${API}/catalog_quality/status?item_id=${c.item_id}&v=3`, h);
      const faltam: string[] = quali?.adoption_status?.all?.missing_attributes ?? [];
      await sb.from("ml_analise").update({
        faltam_atributos: faltam,
        sugestao: [],
      }).eq("conta", conta).eq("item_id", c.item_id);
      await sb.from("ml_log_acoes").insert({ conta, item_id: c.item_id, title: corpo.title ?? null, acao: "ficha_tecnica",
        origem: "site", detalhe: `análise — ficha técnica: ${atributos.map((a: { id: string }) => a.id).join(", ")}` })
        .then(() => {}, () => {});
      return json({ ok: true, ainda_faltam: faltam });
    }

    return json({ erro: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
