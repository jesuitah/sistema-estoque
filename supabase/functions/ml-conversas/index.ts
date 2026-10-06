// Conversas de pós-venda das 3 lojas num lugar só.
//
// Pedido do Matheus (06/10/2026): depois que a reclamação abre, o ML põe o assistente
// dele e a Letícia não fala mais com o comprador. A única janela que sobra é ANTES —
// dúvida, trânsito, chegada. E essa janela FECHA SOZINHA: o assistente encerra por
// silêncio (blocked_by_ai_assistant_contact_closed). Já perdemos uma assim, de um
// comprador dizendo que a peça não parecia original — que é dos motivos que sempre
// batem na reputação.
//
// Ações (POST):
//   { acao: "varrer", dias? }        lê os pedidos recentes das 3 lojas, pega a conversa
//                                    de cada um e grava quem está esperando resposta.
//   { acao: "listar", so_esperando? } devolve a fila pra tela.
//   { acao: "responder", pack_id, texto }  responde e confere.
//   { acao: "visto", pack_id }       marca que alguém daqui já olhou.
//
// DUAS REGRAS QUE NÃO PODEM SER QUEBRADAS:
//   1. Ler SEMPRE com mark_as_read=false. Marcar como lida pela API faz a conversa sumir
//      do painel da Letícia — eu estaria escondendo o trabalho dela, não ajudando.
//   2. Não dá pra INICIAR conversa por aqui: o ML responde 403
//      blocked_by_conversation_initiated_by_seller_limited em mais da metade dos pedidos.
//      A mensagem de confirmação de aplicação tem que sair pelo robô, no painel.

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
const CONTAS = ["KMP", "ERP", "LTS"];
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(conta: string) {
  const { data } = await sb.from("ml_tokens").select("access_token, user_id").eq("conta", conta).maybeSingle();
  if (!data) throw new Error(`conta ${conta} sem token`);
  return { auth: `Bearer ${data.access_token}`, seller: String(data.user_id) };
}

async function lerJson(url: string, auth: string) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(API + url, { headers: { Authorization: auth } });
      if (r.ok) return await r.json();
      // 4xx aqui é resposta, não falha: pedido sem conversa devolve 403/404 o tempo todo.
      if (r.status < 500 && r.status !== 429) return null;
    } catch (_e) { /* tenta de novo */ }
    await espera(400 * (i + 1));
  }
  return null;
}

function primeiroNome(nome: string | null | undefined) {
  return String(nome || "").trim().split(/\s+/)[0] || "";
}

async function varrer(dias: number) {
  const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
  const resumo: Record<string, number> = {};
  let gravadas = 0, esperando = 0;

  for (const conta of CONTAS) {
    const t = await token(conta);
    let pedidos: any[] = [];
    for (let off = 0; off < 1000; off += 50) {
      const p = await lerJson(
        `/orders/search?seller=${t.seller}&order.date_created.from=${desde}T00:00:00.000-03:00&limit=50&offset=${off}`,
        t.auth,
      );
      const res = p?.results ?? [];
      pedidos.push(...res);
      if (res.length < 50) break;
      await espera(150);
    }

    for (const ped of pedidos) {
      const pack = String(ped.pack_id ?? ped.id);
      // mark_as_read=false: ver a conversa não pode consumi-la do painel dela.
      const c = await lerJson(`/messages/packs/${pack}/sellers/${t.seller}?tag=post_sale&mark_as_read=false`, t.auth);
      await espera(120);
      if (!c) continue;
      const msgs: any[] = c.messages ?? [];
      if (!msgs.length) continue;

      const cs = c.conversation_status ?? {};
      // A API devolve a conversa da mais nova pra mais velha.
      const ordenadas = msgs.slice().sort((a, b) =>
        String(a.message_date?.received ?? a.message_date ?? "").localeCompare(
          String(b.message_date?.received ?? b.message_date ?? "")));
      const ultima = ordenadas[ordenadas.length - 1];
      const deComprador = String(ultima?.from?.user_id ?? "") !== t.seller;
      const aberta = String(cs.status ?? "") === "active";

      const item = (ped.order_items ?? [])[0] ?? {};
      // O nome do comprador não vem na busca de pedidos, só no detalhe. Como é ele que
      // abre a conversa na tela (e vai no "Bom dia Fulano" da mensagem), vale a chamada
      // extra — e só para os poucos pedidos que têm conversa.
      let nome = primeiroNome(ped.buyer?.first_name);
      if (!nome) {
        const det = await lerJson(`/orders/${ped.id}`, t.auth);
        nome = primeiroNome(det?.buyer?.first_name) || String(det?.buyer?.nickname ?? "");
        await espera(100);
      }
      const linha = {
        pack_id: pack,
        conta,
        order_id: String(ped.id),
        buyer_id: String(ped.buyer?.id ?? ""),
        buyer_nome: nome,
        item_title: item.item?.title ?? null,
        sku: item.item?.seller_sku ?? null,
        valor: item.unit_price ?? null,
        status: cs.status ?? null,
        substatus: cs.substatus ?? null,
        total_msgs: c.paging?.total ?? msgs.length,
        ultima_de: deComprador ? "comprador" : "vendedor",
        ultima_texto: String(ultima?.text ?? "").slice(0, 1000),
        ultima_em: ultima?.message_date?.received ?? ultima?.message_date ?? null,
        // o que precisa de gente: o comprador falou por último e ainda dá pra responder
        esperando: deComprador && aberta,
        pedido_em: ped.date_created ?? null,
        atualizado_em: new Date().toISOString(),
      };
      const { error } = await sb.from("ml_conversas").upsert(linha, { onConflict: "pack_id" });
      if (!error) { gravadas++; if (linha.esperando) esperando++; }
      resumo[`${conta}:${linha.status}/${linha.substatus ?? "-"}`] =
        (resumo[`${conta}:${linha.status}/${linha.substatus ?? "-"}`] ?? 0) + 1;
    }
  }
  return { ok: true, gravadas, esperando, resumo };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const c = await req.json().catch(() => ({}));

    if (c.acao === "varrer") return json(await varrer(Number(c.dias) || 7));

    if (c.acao === "listar") {
      let q = sb.from("ml_conversas").select("*").order("ultima_em", { ascending: false }).limit(300);
      if (c.so_esperando) q = q.eq("esperando", true);
      const { data, error } = await q;
      if (error) return json({ erro: error.message }, 500);
      return json({ conversas: data ?? [] });
    }

    if (c.acao === "visto") {
      await sb.from("ml_conversas").update({ visto_em: new Date().toISOString() }).eq("pack_id", String(c.pack_id));
      return json({ ok: true });
    }

    if (c.acao === "responder") {
      const { data: conv } = await sb.from("ml_conversas").select("*").eq("pack_id", String(c.pack_id)).maybeSingle();
      if (!conv) return json({ erro: "conversa não encontrada" }, 404);
      const texto = String(c.texto ?? "").trim();
      if (!texto) return json({ erro: "texto vazio" }, 400);
      const t = await token(conv.conta);
      const r = await fetch(`${API}/messages/packs/${conv.pack_id}/sellers/${t.seller}?tag=post_sale`, {
        method: "POST",
        headers: { Authorization: t.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ from: { user_id: t.seller }, to: { user_id: String(conv.buyer_id) }, text: texto }),
      });
      const corpo = await r.text();
      if (!r.ok) {
        // O 403 aqui costuma ser a janela já fechada — vale dizer isso em vez do código cru.
        const fechada = /initiated_by_seller_limited|contact_closed|blocked/i.test(corpo);
        return json({
          erro: fechada
            ? "o Mercado Livre não aceita mais mensagem nessa conversa (a janela fechou)"
            : "não consegui enviar",
          detalhe: corpo.slice(0, 300),
        }, 400);
      }
      await sb.from("ml_conversas").update({
        ultima_de: "vendedor", ultima_texto: texto, ultima_em: new Date().toISOString(),
        esperando: false, atualizado_em: new Date().toISOString(),
      }).eq("pack_id", conv.pack_id);
      return json({ ok: true });
    }

    return json({ erro: "ação inválida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
