// Perguntas das 3 lojas num lugar só — no sistema e no app do celular.
//
// Pedido do Matheus (17/09/2026): ver e responder as perguntas de KMP, ERP e LTS juntas,
// com notificação no celular a CADA pergunta nova, 24h por dia, 7 dias por semana, e
// poder responder pelo próprio app. Respostas rápidas ficam na tabela
// respostas_rapidas (a API do ML não entrega as do painel).
//
// Ações (POST):
//   { acao: "sincronizar" }             lê as perguntas sem resposta das 3 lojas, grava,
//                                       marca as que foram respondidas por fora (painel
//                                       do ML) e NOTIFICA as novas. Roda pelo cron a
//                                       cada minuto.
//   { acao: "responder", id, texto }    responde no ML e confere.

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
const API = "https://api.mercadolibre.com";
const APP = "https://jesuitah.github.io/sistema-estoque/alertas/#perguntas";
const CONTAS = ["KMP", "ERP", "LTS"];

// Só notifica pergunta recente. Sem isto, a primeira sincronização mandaria notificação
// de pergunta esquecida de meses atrás.
const NOTIFICAR_ATE_MIN = 60;

async function token(conta: string) {
  const { data } = await sb.from("ml_tokens").select("access_token, user_id").eq("conta", conta).maybeSingle();
  if (!data) throw new Error(`conta ${conta} sem token`);
  return { auth: `Bearer ${data.access_token}`, userId: String(data.user_id) };
}

async function lerJson(url: string, auth: string) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(API + url, { headers: { Authorization: auth } });
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) return null;
    } catch (_e) { /* tenta de novo */ }
    await new Promise((ok) => setTimeout(ok, 700 * (i + 1)));
  }
  return null;
}

let pushPronto = false;
async function notificar(titulo: string, mensagem: string, tag: string) {
  if (!pushPronto) {
    const { data } = await sb.from("push_config").select("*").eq("id", 1).single();
    if (!data) return;
    webpush.setVapidDetails(data.contato, data.vapid_publica, data.vapid_privada);
    pushPronto = true;
  }
  const { data: inscricoes } = await sb.from("push_inscricoes").select("*");
  const carga = JSON.stringify({ titulo, mensagem, url: APP, tag });
  for (const i of inscricoes ?? []) {
    try {
      await webpush.sendNotification({ endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, carga,
        { TTL: 60 * 60 * 24, urgency: "high" });
    } catch (e) {
      const st = (e as { statusCode?: number }).statusCode;
      if (st === 404 || st === 410) await sb.from("push_inscricoes").delete().eq("id", i.id);
    }
  }
}

async function sincronizar() {
  const agora = Date.now();
  let novas = 0, notificadas = 0, fechadas = 0;
  const erros: string[] = [];

  for (const conta of CONTAS) {
    try {
      const t = await token(conta);
      const abertas: any[] = [];
      for (let offset = 0; offset < 500; offset += 50) {
        const d = await lerJson(`/questions/search?seller_id=${t.userId}&status=UNANSWERED&api_version=4&limit=50&offset=${offset}&sort_fields=date_created&sort_types=DESC`, t.auth);
        const lote = (d?.questions ?? []) as any[];
        abertas.push(...lote);
        if (lote.length < 50) break;
      }
      const ids = abertas.map((q) => q.id);

      // Já conhecidas: não relê o anúncio de novo.
      const { data: conhecidas } = ids.length
        ? await sb.from("ml_perguntas").select("id, notificado_em").in("id", ids)
        : { data: [] };
      const jaTem = new Map((conhecidas ?? []).map((x) => [Number(x.id), x]));

      for (const q of abertas) {
        if (jaTem.has(Number(q.id))) continue;
        const item = await lerJson(`/items/${q.item_id}?attributes=id,title,price,available_quantity,thumbnail,secure_thumbnail,seller_custom_field,attributes`, t.auth);
        const sku = (item?.attributes ?? []).find((a: any) => a.id === "SELLER_SKU")?.value_name ?? item?.seller_custom_field ?? null;
        const comprador = q.from?.id ? (await lerJson(`/users/${q.from.id}`, t.auth))?.nickname ?? null : null;
        const recente = agora - new Date(q.date_created).getTime() < NOTIFICAR_ATE_MIN * 60000;
        await sb.from("ml_perguntas").upsert({
          id: q.id, conta, item_id: q.item_id, texto: q.text, comprador,
          perguntado_em: q.date_created, status: "UNANSWERED",
          titulo: item?.title ?? null, sku, preco: item?.price ?? null, estoque: item?.available_quantity ?? null,
          foto: item?.secure_thumbnail ?? item?.thumbnail ?? null,
          notificado_em: recente ? new Date().toISOString() : null,
        });
        novas++;
        if (recente) {
          await notificar(`❓ Pergunta na ${conta}`, `${q.text}${item?.title ? `\n— ${item.title}` : ""}`, `pergunta-${q.id}`);
          notificadas++;
        }
      }

      // Estavam abertas aqui e não estão mais no ML: foram respondidas (ou apagadas) por fora.
      const { data: nossas } = await sb.from("ml_perguntas").select("id").eq("conta", conta).eq("status", "UNANSWERED");
      const abertasSet = new Set(ids.map(Number));
      for (const p of nossas ?? []) {
        if (abertasSet.has(Number(p.id))) continue;
        const q = await lerJson(`/questions/${p.id}?api_version=4`, t.auth);
        await sb.from("ml_perguntas").update({
          status: q?.status ?? "CLOSED",
          resposta: q?.answer?.text ?? null,
          respondida_em: q?.answer?.date_created ?? new Date().toISOString(),
        }).eq("id", p.id);
        fechadas++;
      }
    } catch (e) {
      erros.push(`${conta}: ${(e as Error).message}`);
    }
  }
  return { novas, notificadas, fechadas, erros };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const c = await req.json().catch(() => ({}));

    if (c.acao === "sincronizar") return json(await sincronizar());

    if (c.acao === "responder") {
      const texto = String(c.texto ?? "").trim();
      if (!texto) return json({ ok: false, motivo: "a resposta está vazia" }, 400);
      if (texto.length > 2000) return json({ ok: false, motivo: "a resposta passa de 2000 letras" }, 400);
      const { data: p } = await sb.from("ml_perguntas").select("id, conta").eq("id", c.id).maybeSingle();
      if (!p) return json({ ok: false, motivo: "pergunta não encontrada" }, 404);
      const t = await token(p.conta);
      const r = await fetch(`${API}/answers`, {
        method: "POST", headers: { Authorization: t.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ question_id: Number(p.id), text: texto }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Já respondida (por outra pessoa, no painel ou no outro aparelho): atualiza e avisa.
        const q = await lerJson(`/questions/${p.id}?api_version=4`, t.auth);
        if (q?.status && q.status !== "UNANSWERED") {
          await sb.from("ml_perguntas").update({ status: q.status, resposta: q.answer?.text ?? null,
            respondida_em: q.answer?.date_created ?? new Date().toISOString() }).eq("id", p.id);
          return json({ ok: false, ja_respondida: true, motivo: "essa pergunta já tinha sido respondida" });
        }
        const motivo = [corpo.message, ...((corpo.cause ?? []) as any[]).map((x) => x.message ?? x)].filter(Boolean).join(" · ");
        return json({ ok: false, motivo: motivo || `o Mercado Livre respondeu ${r.status}` });
      }
      await sb.from("ml_perguntas").update({ status: "ANSWERED", resposta: texto, respondida_em: new Date().toISOString() }).eq("id", p.id);
      return json({ ok: true });
    }

    return json({ erro: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
