// Pausa uma lista de anúncios — o "acabou a peça" da aba de Anúncios.
//
// É o espelho do ml-reativar-lote. Acabou o produto na empresa (vendeu no Mercado
// Livre, vendeu no balcão, tanto faz): os anúncios das três lojas que dependem dessa
// peça saem do ar, e o Envios Flex vai junto.
//
// DOIS CAMINHOS, porque um anúncio não é igual ao outro:
//
//   1. Anúncio comum -> PUT status=paused aqui mesmo, e o Flex vai junto.
//
//   2. ANÚNCIO NO FULL -> NÃO PAUSA. Só desliga o Flex.
//
//      Regra do Matheus, 11/09/2026, e o motivo é simples quando se olha de onde sai a
//      peça: o estoque do Full está no galpão do Mercado Livre, não aqui. Acabar na
//      empresa não impede aquele anúncio de continuar vendendo — quem separa e despacha
//      é o ML. Pausar seria desligar uma venda que ainda existe.
//
//      Mas o Flex, não: Flex é entrega feita por NÓS, com peça daqui. Sem peça aqui,
//      prometer entrega no mesmo dia é prometer o que não se pode cumprir.
//
//      É por isso que "estoque zerado -> pausa" não vale no Full: lá o estoque que
//      importa não é o nosso.
//
// O Flex, nos dois casos, é tarefa do robô: o ML responde "shipping.tags is not
// modifiable" a qualquer tentativa por API. Ver PLANO-ROBO.md.

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

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Erro 500 do ML é passageiro; 4xx é recusa de verdade. Mesma regra do reativar.
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
  if (/internal_server_error|Something went wrong/i.test(t)) {
    return "o Mercado Livre falhou (erro interno dele) mesmo depois de 3 tentativas — tente daqui a pouco";
  }
  return t.trim() || `o ML respondeu ${status}`;
}

// Põe o Flex na fila do robô. Não duplica se já houver uma esperando.
async function enfileirarDesligarFlex(conta: string, itemId: string) {
  try {
    const { data: jaTem } = await sb.from("ml_tarefas_robo")
      .select("id").eq("tipo", "desligar_flex").eq("conta", conta)
      .in("status", ["pendente", "rodando"]).contains("params", { item_id: itemId });
    if (jaTem && jaTem.length) return false;

    await sb.from("ml_tarefas_robo").insert({
      conta, tipo: "desligar_flex", status: "pendente",
      params: { item_id: itemId }, criado_por: "sistema",
    });
    return true;
  } catch (_e) { return false; }
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

    const pausados: unknown[] = [];
    const noFullSoFlex: unknown[] = [];
    const recusados: unknown[] = [];
    let flexNaFila = 0;

    for (const it of itens) {
      const auth = { Authorization: `Bearer ${tokens[it.conta]}`, "Content-Type": "application/json" };

      // O que este anúncio é HOJE — direto no ML, não no nosso catálogo. O catálogo
      // atualiza de 3 em 3 horas e um anúncio pode ter entrado no Full nesse meio-tempo.
      const rEstado = await chamarComInsistencia(
        `https://api.mercadolibre.com/items/${it.item_id}?attributes=id,title,status,shipping`,
        { headers: auth });
      if (!rEstado || !rEstado.ok) {
        recusados.push({ conta: it.conta, item_id: it.item_id, motivo: "não consegui ler o anúncio no Mercado Livre" });
        continue;
      }
      const estado = await rEstado.json();
      const titulo = estado.title ?? "";
      const noFull = estado.shipping?.logistic_type === "fulfillment";
      const temFlex = (estado.shipping?.tags ?? []).includes("self_service_in");

      // Já estava pausado: não é erro, é trabalho que não precisa ser feito. Mas o Flex
      // continua sendo assunto — pausado com Flex ligado é exatamente o buraco que a
      // regra da casa fecha.
      if (estado.status === "paused") {
        if (temFlex && await enfileirarDesligarFlex(it.conta, it.item_id)) flexNaFila++;
        pausados.push({ conta: it.conta, item_id: it.item_id, titulo, ja_estava: true });
        continue;
      }

      // NO FULL O ANÚNCIO FICA NO AR. Só o Flex sai. Ver o comentário do topo.
      if (noFull) {
        const foi = temFlex && await enfileirarDesligarFlex(it.conta, it.item_id);
        if (foi) flexNaFila++;
        noFullSoFlex.push({
          conta: it.conta, item_id: it.item_id, titulo,
          tinha_flex: temFlex, flex_na_fila: foi,
        });
        continue;
      }

      const r = await chamarComInsistencia(`https://api.mercadolibre.com/items/${it.item_id}`, {
        method: "PUT", headers: auth, body: JSON.stringify({ status: "paused" }),
      });

      if (r && r.ok) {
        if (temFlex && await enfileirarDesligarFlex(it.conta, it.item_id)) flexNaFila++;
        pausados.push({ conta: it.conta, item_id: it.item_id, titulo, flex_na_fila: temFlex });
        // O catálogo local acompanha na hora: sem isso a tela continuaria mostrando
        // "ativo" até a próxima sincronização, e você pausaria de novo sem querer.
        await sb.from("ml_anuncios").update({ status: "paused" })
          .eq("conta", it.conta).eq("item_id", it.item_id);
      } else {
        const erro = r ? await r.json().catch(() => ({})) : null;
        const bruto = String(erro?.message ?? "")
          + (erro?.cause ? " " + JSON.stringify(erro.cause) : "");
        recusados.push({
          conta: it.conta, item_id: it.item_id, titulo,
          motivo: r ? motivoEmPortugues(bruto, r.status) : "não consegui falar com o Mercado Livre",
        });
      }
    }

    // Histórico: quem pausou o quê, e quando. O prefixo é o que a aba usa pra achar
    // as próprias linhas depois.
    const registros = [
      ...(pausados as { conta: string; item_id: string; titulo: string; ja_estava?: boolean }[]).map((x) => ({
        conta: x.conta, item_id: x.item_id, title: x.titulo, acao: "inativado", origem: "site",
        detalhe: `acabou a peça: ${x.ja_estava ? "já estava pausado" : "pausado"}`,
      })),
      ...(noFullSoFlex as { conta: string; item_id: string; titulo: string; tinha_flex: boolean }[]).map((x) => ({
        conta: x.conta, item_id: x.item_id, title: x.titulo, acao: "full_so_flex", origem: "site",
        detalhe: x.tinha_flex
          ? "acabou a peça: está no Full, continua vendendo — só o Flex foi desligado"
          : "acabou a peça: está no Full, continua vendendo — já estava sem Flex",
      })),
      ...(recusados as { conta: string; item_id: string; titulo: string; motivo: string }[]).map((x) => ({
        conta: x.conta, item_id: x.item_id, title: x.titulo, acao: "falhou", origem: "site",
        detalhe: `acabou a peça: ${x.motivo}`.slice(0, 300),
      })),
    ];
    if (registros.length) await sb.from("ml_log_acoes").insert(registros).then(() => {}, () => {});

    return json({ pausados, no_full_so_flex: noFullSoFlex, recusados, flex_na_fila: flexNaFila });
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
