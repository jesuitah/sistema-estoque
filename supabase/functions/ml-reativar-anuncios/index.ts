import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QUANTIDADE_PADRAO_REATIVACAO = 89;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// REGRA COMPLETA (definida pelo Matheus em 2026-08-25)
//
// Todo anúncio que cai em "sem estoque" precisa SAIR de lá — anúncio parado nessa aba
// atrapalha o trabalho da equipe. O caminho depende de duas perguntas:
//
//   1. Está no Full?
//        sim -> o robô precisa tirar do Full primeiro (a API oficial não faz isso)
//        não -> segue direto
//
//   2. Temos a peça aqui na empresa?
//        sim -> reativa com 89 unidades e DEIXA ATIVO (volta a vender daqui)
//        não -> reativa com 89 e PAUSA em seguida (vai pra "inativos" e some da aba)
//
// SKU não reconhecido conta como "não temos" (vai pra inativos), mas é sinalizado
// à parte pro Matheus cadastrar o código no sistema.
//
// Por que reativar com 89 mesmo sem estoque: é o único jeito de trocar o motivo da
// pausa de "out_of_stock" para "paused_by_seller", que é o que faz o anúncio mudar
// de aba no Mercado Livre. Testado e confirmado.
//
// REGRA DO FLEX (definida pelo Matheus em 2026-09-10)
//
// Estoque zerado -> anúncio pausado E Envios Flex desligado. Sem exceção, seja o envio
// normal, turbo, flex ou Full. O contrário NÃO vale: quando o anúncio fica ATIVO, o
// Flex não é tocado — fica como estava.
//
// Tudo que é feito fica gravado em `ml_log_acoes`: o resultado desta função só vivia
// na tela e sumia ao atualizar, sem deixar histórico de nada.

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

function parseSellerSku(sellerSku: string): { marca: string; sku: string } | null {
  const partes = sellerSku.split(":");
  if (partes.length < 2) return null;
  return { marca: partes[0].trim().toUpperCase(), sku: partes.slice(1).join(":").trim().toUpperCase() };
}

function parseComponentesSku(sellerSku: string | null): { marca: string; sku: string }[] {
  if (!sellerSku) return [];
  if (/^\s*KIT\s*:/i.test(sellerSku)) {
    const resto = sellerSku.replace(/^\s*KIT\s*:\s*/i, "");
    return resto.split("+").map((p) => parseSellerSku(p.trim())).filter((x): x is { marca: string; sku: string } => !!x);
  }
  const unico = parseSellerSku(sellerSku);
  return unico ? [unico] : [];
}

async function carregarEstoqueCompleto(supabase: any): Promise<Map<string, number>> {
  const mapa = new Map<string, number>();
  const tamanhoPagina = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("estoque")
      .select("marca, sku, unidades")
      .range(offset, offset + tamanhoPagina - 1);
    if (error || !data) break;
    for (const r of data) {
      mapa.set((r.marca || "").toUpperCase() + "|" + (r.sku || "").toUpperCase(), r.unidades);
    }
    if (data.length < tamanhoPagina) break;
    offset += tamanhoPagina;
  }
  return mapa;
}

// Grava o que foi feito. Nunca deixa uma falha de log derrubar a operação em si.
async function registrar(supabase: any, linhas: any[]) {
  if (!linhas.length) return;
  try {
    await supabase.from("ml_log_acoes").insert(linhas);
  } catch (_e) { /* log é secundário; a ação no ML já aconteceu */ }
}

// Manda o Flex pra fila do robô — não dá pra desligar aqui.
//
// A API oficial responde "shipping.tags is not modifiable": só o robô consegue,
// clicando no painel (~20s por anúncio). Ver PLANO-ROBO.md.
//
// Este gancho fechou um buraco encontrado em 11/09/2026: o caminho do robô (anúncio
// no Full) já desligava o Flex ao pausar, mas ESTE caminho — o anúncio comum, que é a
// maioria — pausava e deixava o Flex ligado. A varredura de hora em hora acabava
// pegando, mas só depois de o catálogo atualizar. Aqui é na hora.
async function enfileirarDesligarFlex(supabase: any, conta: string, itemId: string) {
  try {
    const { data: anuncio } = await supabase.from("ml_anuncios")
      .select("flex").eq("conta", conta).eq("item_id", itemId).maybeSingle();
    if (!anuncio || !anuncio.flex) return false;   // nada a desligar

    const { data: jaTem } = await supabase.from("ml_tarefas_robo")
      .select("id").eq("tipo", "desligar_flex").eq("conta", conta)
      .in("status", ["pendente", "rodando"]).contains("params", { item_id: itemId });
    if (jaTem && jaTem.length) return false;       // já está na fila

    await supabase.from("ml_tarefas_robo").insert({
      conta, tipo: "desligar_flex", status: "pendente",
      params: { item_id: itemId }, criado_por: "sistema",
    });
    return true;
  } catch (_e) {
    // Enfileirar é acessório: a pausa no ML já aconteceu e a varredura de hora em hora
    // é a rede de segurança. Nunca derruba a reativação por causa disto.
    return false;
  }
}

// Reativa com 89 unidades. Se `pausarDepois`, pausa em seguida — é o que move o
// anúncio de "sem estoque" para "inativos".
async function reativar(accessToken: string, itemId: string, pausarDepois: boolean) {
  const resp = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "active", available_quantity: QUANTIDADE_PADRAO_REATIVACAO }),
  });
  if (!resp.ok) {
    const detalhe = await resp.json().catch(() => null);
    return { ok: false, etapa: "ativar", detalhe };
  }
  // Ficou ATIVO: o Flex não é tocado, fica como estava. A regra da casa só manda
  // desligar quando o estoque zera, nunca ligar quando volta a vender por aqui.
  if (!pausarDepois) return { ok: true };

  const respPausa = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "paused" }),
  });
  if (!respPausa.ok) {
    const detalhe = await respPausa.json().catch(() => null);
    return { ok: false, etapa: "pausar", detalhe };
  }
  return { ok: true };
}

async function processarConta(supabase: any, conta: any, estoqueMapa: Map<string, number>) {
  let accessToken = conta.access_token;
  const expiraEm = new Date(conta.expires_at).getTime() - Date.now();
  if (expiraEm < 10 * 60 * 1000) {
    const novo = await renovarToken(supabase, conta);
    if (novo) accessToken = novo;
  }

  const ids: string[] = [];
  let offset = 0;
  while (true) {
    const resp = await fetch(
      `https://api.mercadolibre.com/users/${conta.user_id}/items/search?status=paused&sub_status=out_of_stock&limit=50&offset=${offset}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await resp.json();
    if (!resp.ok) return { erro: "falha ao listar anúncios pausados", detalhe: data };
    const res = data.results ?? [];
    ids.push(...res);
    offset += res.length;
    if (res.length === 0 || offset >= (data.paging?.total ?? 0)) break;
  }

  const reativados: any[] = [];
  const movidosParaInativos: any[] = [];
  const precisaRobo: any[] = [];
  const skuNaoReconhecido: any[] = [];
  const falhas: any[] = [];
  const paraRegistrar: any[] = [];
  let flexNaFila = 0;

  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const resp = await fetch(
      `https://api.mercadolibre.com/items?ids=${lote.join(",")}&attributes=id,title,attributes,shipping,permalink`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await resp.json();
    if (!resp.ok) continue;

    for (const entrada of data) {
      if (entrada.code !== 200) continue;
      const item = entrada.body;

      const skuAttr = (item.attributes ?? []).find((a: any) => a.id === "SELLER_SKU");
      const sellerSkuBruto = skuAttr?.value_name ?? null;
      const componentes = parseComponentesSku(sellerSkuBruto);
      const ehFull = item.shipping?.logistic_type === "fulfillment";

      const base = {
        conta: conta.conta,
        item_id: item.id,
        title: item.title,
        sku_bruto: sellerSkuBruto,
        permalink: item.permalink,
      };
      const paraLog = {
        conta: conta.conta, item_id: item.id, title: item.title,
        sku_bruto: sellerSkuBruto, origem: "sistema",
      };

      const naoReconhecido = componentes.length === 0;
      const faltando = naoReconhecido
        ? []
        : componentes.filter((c) => (estoqueMapa.get(c.marca + "|" + c.sku) ?? 0) <= 0);
      const temEstoque = !naoReconhecido && faltando.length === 0;

      const motivo = naoReconhecido
        ? "SKU não reconhecido — cadastrar no sistema"
        : faltando.length > 0
          ? (componentes.length > 1
              ? `Kit incompleto: falta ${faltando.map((f) => f.marca + ": " + f.sku).join(", ")}`
              : "Sem estoque no sistema")
          : null;

      if (naoReconhecido) {
        skuNaoReconhecido.push({ ...base, motivo });
        paraRegistrar.push({ ...paraLog, acao: "sku_desconhecido", detalhe: sellerSkuBruto });
      }

      // Full precisa passar pelo robô antes de qualquer coisa. O robô registra o dele,
      // e é ele quem desliga o Flex desses no fim da própria tarefa.
      if (ehFull) {
        precisaRobo.push({
          ...base,
          tem_estoque: temEstoque,
          acao_depois: temEstoque ? "ativar" : "inativar",
          motivo: motivo ?? "Full com estoque aqui",
        });
        continue;
      }

      const resultado = await reativar(accessToken, item.id, !temEstoque);
      if (!resultado.ok) {
        falhas.push({ ...base, motivo: `Falha ao ${resultado.etapa}`, detalhe: resultado.detalhe });
        paraRegistrar.push({ ...paraLog, acao: "falhou", detalhe: `Falha ao ${resultado.etapa}` });
        continue;
      }
      if (temEstoque) {
        reativados.push({ ...base, unidades_anunciadas: QUANTIDADE_PADRAO_REATIVACAO });
        paraRegistrar.push({ ...paraLog, acao: "reativado", detalhe: `voltou a vender com ${QUANTIDADE_PADRAO_REATIVACAO} unidades` });
      } else {
        // Pausou = estoque zerado. Regra da casa: o Flex vai junto.
        const foiPraFila = await enfileirarDesligarFlex(supabase, conta.conta, item.id);
        if (foiPraFila) flexNaFila++;
        movidosParaInativos.push({ ...base, motivo, flex_na_fila: foiPraFila });
        paraRegistrar.push({
          ...paraLog, acao: "inativado",
          detalhe: motivo + (foiPraFila ? " (Flex na fila do robô)" : ""),
        });
      }
    }
  }

  await registrar(supabase, paraRegistrar);

  return {
    total_pausados_sem_estoque: ids.length,
    reativados,
    movidos_para_inativos: movidosParaInativos,
    precisa_acao_manual_full: precisaRobo,   // nome mantido: o site já usa esta chave
    sku_nao_reconhecido: skuNaoReconhecido,
    permanecem_pausados: falhas,             // agora só sobra aqui o que FALHOU de verdade
    flex_na_fila_do_robo: flexNaFila,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: contas, error: errContas } = await supabase
    .from("ml_tokens")
    .select("conta, user_id, access_token, refresh_token, expires_at");
  if (errContas || !contas) {
    return new Response(JSON.stringify({ erro: "Falha ao buscar contas", detalhe: errContas }), {
      status: 500, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const estoqueMapa = await carregarEstoqueCompleto(supabase);

  const resultado: Record<string, unknown> = {};
  for (const conta of contas) {
    resultado[conta.conta] = await processarConta(supabase, conta, estoqueMapa);
  }

  return new Response(JSON.stringify(resultado, null, 2), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
