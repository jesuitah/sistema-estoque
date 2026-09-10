// Reativa uma lista de anúncios — o "chegou mercadoria" da aba de Anúncios.
//
// Só faz a parte que a API oficial permite: voltar o anúncio a vender com a
// quantidade padrão da empresa. O Flex NÃO entra aqui: o Mercado Livre não deixa
// mexer nele por API (`shipping.tags is not modifiable`), então quem liga é o robô,
// clicando no painel. Ver PLANO-ROBO.md.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// 89 é o padrão da empresa, o mesmo que o robô usa ao reativar na patrulha do Full.
// Está aqui e lá; se um dia mudar, tem que mudar nos dois — por isso o número aparece
// escrito na resposta, pra ficar visível na tela em vez de virar mágica.
const QUANTIDADE_PADRAO = 89;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Erro 500 do ML é passageiro; 4xx é recusa de verdade. Mesma regra das promoções.
async function chamarComInsistencia(url: string, opcoes: RequestInit, tentativas = 3) {
  let ultima: Response | null = null;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(url, opcoes);
      if (r.ok || (r.status >= 400 && r.status < 500)) return r;
      ultima = r;
    } catch (_e) { ultima = null; }
    if (i < tentativas) await espera(i * 1200);
  }
  return ultima;
}

function motivoEmPortugues(bruto: string, status: number) {
  const t = String(bruto || "");
  if (/item.*not.*modifiable|Cannot update item/i.test(t)) {
    return "o Mercado Livre não deixa alterar este anúncio agora — veja se ele está em revisão ou encerrado";
  }
  if (/quantity/i.test(t)) return "o ML recusou a quantidade: " + t;
  if (/internal_server_error|Something went wrong/i.test(t)) {
    return "o Mercado Livre falhou (erro interno dele) mesmo depois de 3 tentativas — tente daqui a pouco";
  }
  return t.trim() || `o ML respondeu ${status}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);

  try {
    const corpo = await req.json();
    const itens: { conta: string; item_id: string }[] = corpo.itens ?? [];
    if (!itens.length) return json({ erro: "nenhum anúncio recebido" }, 400);

    // Um token por conta, não um por anúncio.
    const contas = [...new Set(itens.map((i) => i.conta))];
    const tokens: Record<string, string> = {};
    for (const c of contas) {
      const { data } = await sb.from("ml_tokens").select("access_token").eq("conta", c).maybeSingle();
      if (!data) return json({ erro: `conta ${c} sem token` }, 400);
      tokens[c] = data.access_token;
    }

    const reativados: unknown[] = [];
    const recusados: unknown[] = [];

    for (const it of itens) {
      const auth = { Authorization: `Bearer ${tokens[it.conta]}`, "Content-Type": "application/json" };
      const r = await chamarComInsistencia(`https://api.mercadolibre.com/items/${it.item_id}`, {
        method: "PUT", headers: auth,
        body: JSON.stringify({ status: "active", available_quantity: QUANTIDADE_PADRAO }),
      });

      if (r && r.ok) {
        reativados.push({ conta: it.conta, item_id: it.item_id });
        // O catálogo local acompanha na hora: sem isso a tela continuaria mostrando
        // "PARADO" até o próximo recatalogar, e você reativaria de novo sem querer.
        await sb.from("ml_anuncios")
          .update({ status: "active", available_quantity: QUANTIDADE_PADRAO })
          .eq("conta", it.conta).eq("item_id", it.item_id);
      } else {
        const erro = r ? await r.json().catch(() => ({})) : null;
        const bruto = String(erro?.message ?? "")
          + (erro?.cause ? " " + JSON.stringify(erro.cause) : "");
        recusados.push({
          conta: it.conta, item_id: it.item_id,
          motivo: r ? motivoEmPortugues(bruto, r.status) : "não consegui falar com o Mercado Livre",
        });
      }
    }

    // Histórico: quem reativou o quê, e quando.
    const registros = [
      ...(reativados as { conta: string; item_id: string }[]).map((x) => ({
        conta: x.conta, item_id: x.item_id, acao: "reativado", origem: "site",
        detalhe: `chegou mercadoria: reativado com ${QUANTIDADE_PADRAO} unidades`,
      })),
      ...(recusados as { conta: string; item_id: string; motivo: string }[]).map((x) => ({
        conta: x.conta, item_id: x.item_id, acao: "falhou", origem: "site",
        detalhe: `chegou mercadoria: ${x.motivo}`.slice(0, 300),
      })),
    ];
    if (registros.length) await sb.from("ml_log_acoes").insert(registros).then(() => {}, () => {});

    return json({ reativados, recusados, quantidade: QUANTIDADE_PADRAO });
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
