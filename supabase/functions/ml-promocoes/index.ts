// Central de Promoções — tudo pela API oficial do Mercado Livre.
//
// Não usa o painel nem o robô do PC: são chamadas oficiais, então funciona mesmo com
// o computador do Matheus desligado.
//
// AÇÕES
//   ?acao=listar            devolve as promoções e os anúncios (lê o cache, é instantâneo)
//   POST ?acao=ativar       coloca anúncios numa promoção, ou troca o % de quem já está
//   POST ?acao=sair         tira anúncios de uma promoção ("Deixar de participar")
//
// A varredura (descobrir o que cada anúncio aceita) mora no robô: são ~1.100 chamadas
// por loja e a Edge Function estoura o tempo limite antes de terminar.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(conta: string) {
  const { data } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', conta).maybeSingle();
  if (!data) throw new Error(`conta ${conta} sem token`);
  return data;
}

// ── LISTAR ────────────────────────────────────────────────────────────────────
async function listar(conta: string | null, promocaoId: string | null) {
  if (!conta) {
    const { data } = await sb.from('ml_promocoes_resumo').select('*').order('conta');
    return { promocoes: data ?? [] };
  }
  if (!promocaoId) {
    const { data } = await sb.from('ml_promocoes_resumo').select('*').eq('conta', conta);
    return { promocoes: data ?? [] };
  }
  const { data } = await sb.from('ml_promocoes_itens')
    .select('*').eq('conta', conta).eq('promocao_id', promocaoId)
    .order('status').order('title');
  return { itens: data ?? [] };
}

// Traduz o erro cru do Mercado Livre para algo que diga o que fazer.
function motivoEmPortugues(bruto: string) {
  const t = String(bruto || '');
  // O código da oferta vence: o ML recicla os "candidatos" de tempos em tempos, e o que
  // guardamos na última varredura deixa de valer. Não é erro do anúncio nem do sistema.
  if (/CANDIDATE_NOT_FOUND|candidate was not found/i.test(t)) {
    return 'a oferta que o ML tinha para este anúncio expirou — rode "Recatalogar promoções" na aba Robô e tente de novo';
  }
  if (/Offer id is required/i.test(t)) {
    return 'faltou o código da oferta — rode "Recatalogar promoções" na aba Robô';
  }
  if (/already.*(participat|in.*promotion)/i.test(t)) {
    return 'este anúncio já está nesta promoção';
  }
  if (/internal_server_error|Something went wrong/i.test(t)) {
    return 'o Mercado Livre falhou (erro interno dele) mesmo depois de 3 tentativas — tente de novo daqui a pouco';
  }
  return t;
}

// Chama o ML e INSISTE quando o erro é dele.
//
// O Matheus aplicou uma promoção em 45 anúncios: 38 entraram e 7 voltaram com
// "Oops! Something went wrong... internal_server_error". Testando os mesmos 7 logo em
// seguida, TODOS entraram de primeira — era instabilidade do lado deles, e a tela
// mostrou como se os anúncios tivessem algum problema.
//
// 5xx e falha de rede: tenta de novo, com espera crescente.
// 4xx: e recusa de verdade (regra, dado errado) — insistir só atrasaria a resposta.
async function chamarComInsistencia(url: string, opcoes: RequestInit, tentativas = 3) {
  let ultima: Response | null = null;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(url, opcoes);
      if (r.ok || (r.status >= 400 && r.status < 500)) return r;
      ultima = r;
    } catch (_e) {
      ultima = null;
    }
    if (i < tentativas) await espera(i * 1200);
  }
  return ultima;
}

// ── ATIVAR / ALTERAR ──────────────────────────────────────────────────────────
//
// DOIS TIPOS DE PROMOÇÃO, e eles se ativam de jeitos diferentes:
//
//   VOCÊ DEFINE O PREÇO (SELLER_CAMPAIGN, DEAL, PRICE_DISCOUNT, DOD)
//     manda `deal_price`, calculado a partir do percentual que ele digitou.
//
//   O ML DEFINE O PREÇO (SMART "Impulsione", UNHEALTHY_STOCK "Acelere o Full"...)
//     não aceita preço. Exige `offer_id` — o mesmo `ref_id` que ele devolveu ao listar
//     as promoções daquele anúncio. Sem isso responde "Offer id is required".
//     O Matheus tentou ativar 17 anúncios de uma vez e os 17 falharam por isso; era o
//     único caminho da aba que nunca tinha sido testado.
//
// QUEM DECIDE O QUE É PERMITIDO É O MERCADO LIVRE, NÃO ESTE CÓDIGO.
//
// Aqui havia uma checagem que barrava o percentual antes de tentar, usando os campos
// max_discounted_price / min_discounted_price do cache como se fossem "desconto mínimo
// e máximo permitidos". Estava errado: 29 anúncios foram recusados com "8% é pouco, o
// mínimo aqui é 10%" e o Matheus entrou com 8% na mão, pela tela do próprio ML, sem
// nenhum problema. Eram recusas inventadas por este arquivo — nunca chegaram ao ML.
//
// Agora manda e deixa o ML responder. Se ele recusar, mostramos o motivo DELE.
async function ativar(corpo: {
  conta: string; promocao_id: string; promocao_tipo: string;
  percentual?: number; itens: string[];
}) {
  const { conta, promocao_id, promocao_tipo, percentual, itens } = corpo;
  const t = await token(conta);
  const auth = {
    Authorization: `Bearer ${t.access_token}`,
    'Content-Type': 'application/json',
  };

  const { data: cache } = await sb.from('ml_promocoes_itens')
    .select('*').eq('conta', conta).eq('promocao_id', promocao_id).in('item_id', itens);
  const porItem = new Map((cache ?? []).map((c) => [c.item_id, c]));

  const ativados: unknown[] = [];
  const recusados: unknown[] = [];

  for (const itemId of itens) {
    const info = porItem.get(itemId);
    if (!info) { recusados.push({ item_id: itemId, motivo: 'não está no cache — refaça a varredura' }); continue; }

    const payload: Record<string, unknown> = { promotion_id: promocao_id, promotion_type: promocao_tipo };

    const PRECO_LIVRE = ['SELLER_CAMPAIGN', 'DEAL', 'PRICE_DISCOUNT', 'DOD'];
    const temPrecoLivre = PRECO_LIVRE.includes(promocao_tipo);

    if (temPrecoLivre) {
      if (!percentual) { recusados.push({ item_id: itemId, title: info.title, motivo: 'esta promoção precisa de um percentual' }); continue; }
      const cheio = Number(info.preco_cheio);

      // ARREDONDA PRA BAIXO, sempre.
      //
      // Com arredondamento normal, meio centavo virava um centavo A MAIS, e o desconto
      // saía menor do que o pedido. Pra baixo o cliente nunca recebe menos do que foi
      // combinado.
      payload.deal_price = Math.floor(cheio * (1 - percentual / 100) * 100) / 100;
    } else {
      // Promoção do próprio ML: o preço é dele, mas o offer_id é obrigatório.
      if (!info.offer_id) {
        recusados.push({
          item_id: itemId, title: info.title,
          motivo: 'sem o código da oferta — rode "Recatalogar promoções" na aba Robô e tente de novo',
        });
        continue;
      }
      payload.offer_id = info.offer_id;
    }

    // ENTRAR = POST · AUMENTAR O DESCONTO = PUT · DIMINUIR = SAIR E VOLTAR
    //
    // Reenviar POST em quem já está na promoção não muda nada: o ML mantém o preço da
    // primeira vez. O PUT troca o valor — mas só aceita preço MENOR que o atual
    // ("New deal_price must be lower than current deal_price"). Tudo comprovado em
    // teste real: 13% -> 21% pelo PUT funcionou; 21% -> 18% foi recusado.
    //
    // Nas promoções do ML não há o que alterar: ou se está dentro, ou não.
    const url = `https://api.mercadolibre.com/seller-promotions/items/${itemId}?app_version=v2`;
    const jaEstava = info.status === 'started';
    const metodo = (jaEstava && temPrecoLivre) ? 'PUT' : 'POST';

    let r = await chamarComInsistencia(url, { method: metodo, headers: auth, body: JSON.stringify(payload) });
    let erro = (r && r.ok) ? null : await (r?.json().catch(() => ({})) ?? Promise.resolve({}));

    // Pra DIMINUIR o desconto, o único caminho é tirar da promoção e colocar de novo.
    let saiuEVoltou = false;
    if (r && !r.ok && /must be lower/i.test(String(erro?.message ?? ''))) {
      const saida = await fetch(
        `https://api.mercadolibre.com/seller-promotions/items/${itemId}`
        + `?app_version=v2&promotion_type=${promocao_tipo}&promotion_id=${promocao_id}`,
        { method: 'DELETE', headers: auth });

      if (saida.ok) {
        await espera(1500);
        r = await chamarComInsistencia(url, { method: 'POST', headers: auth, body: JSON.stringify(payload) });
        erro = (r && r.ok) ? null : await (r?.json().catch(() => ({})) ?? Promise.resolve({}));
        saiuEVoltou = true;
      }
    }

    if (r && r.ok) {
      // Nas promoções do ML o preço final vem na resposta — é ele quem decide.
      const resposta = await r.json().catch(() => ({}));
      ativados.push({
        item_id: itemId, title: info.title,
        preco: (payload.deal_price as number | undefined) ?? resposta?.price ?? null,
        alterado: (jaEstava && temPrecoLivre) || undefined,
      });
    } else {
      const bruto = String(erro?.message ?? '')
        + (erro?.cause ? ' ' + JSON.stringify(erro.cause) : '')
        + (erro?.error ? ' ' + String(erro.error) : '');
      recusados.push({
        item_id: itemId, title: info.title,
        // Se tiramos e não conseguimos repor, o anúncio ficou FORA da promoção.
        // Isso não pode passar despercebido.
        motivo: (saiuEVoltou ? '⚠ SAIU DA PROMOÇÃO e não voltou: ' : '')
          + (bruto.trim() ? motivoEmPortugues(bruto)
             : r ? `o ML respondeu ${r.status}` : 'não consegui falar com o Mercado Livre'),
      });
    }
  }

  // O cache envelheceu para estes anúncios: marca como ativos os que entraram.
  for (const a of ativados as { item_id: string; preco: number | null }[]) {
    await sb.from('ml_promocoes_itens')
      .update({ status: 'started', preco_promo: a.preco })
      .eq('conta', conta).eq('promocao_id', promocao_id).eq('item_id', a.item_id);
  }

  // Quem foi recusado por código vencido tem o offer_id limpo: assim a tela deixa de
  // prometer o que não funciona, e a próxima varredura traz um código novo.
  const vencidos = (recusados as { item_id: string; motivo: string }[])
    .filter((x) => /expirou/.test(x.motivo)).map((x) => x.item_id);
  if (vencidos.length) {
    await sb.from('ml_promocoes_itens').update({ offer_id: null })
      .eq('conta', conta).eq('promocao_id', promocao_id).in('item_id', vencidos)
      .then(() => {}, () => {});
  }

  // REGISTRO DO QUE FOI PEDIDO
  //
  // Sem isto não há como responder "eu pedi 12% e saiu 10%, onde foi o erro?" — a
  // única prova era o preço final, que não diz o que a tela mandou. Agora fica
  // gravado o percentual que chegou aqui, então dá pra separar erro da tela de erro
  // do servidor sem depender de memória.
  const registros = [
    ...(ativados as { item_id: string; title: string; preco: number | null; alterado?: boolean }[])
      .map((a) => ({
        conta, item_id: a.item_id, title: a.title,
        acao: 'promocao_ativada',
        detalhe: `${promocao_tipo} ${promocao_id}: pediu ${percentual != null ? percentual + '%' : 'o preço do ML'}`
          + (a.preco != null ? ` · ficou R$ ${Number(a.preco).toFixed(2)}` : '')
          + (a.alterado ? ' (alteração)' : ''),
        origem: 'site',
      })),
    ...(recusados as { item_id: string; title?: string; motivo: string }[])
      .map((x) => ({
        conta, item_id: x.item_id, title: x.title ?? null,
        acao: 'promocao_recusada',
        detalhe: `${promocao_tipo} ${promocao_id}: pediu ${percentual != null ? percentual + '%' : 'o preço do ML'} · ${x.motivo}`.slice(0, 300),
        origem: 'site',
      })),
  ];
  if (registros.length) {
    await sb.from('ml_log_acoes').insert(registros).then(() => {}, () => {});
  }

  return { ativados, recusados, percentual_recebido: percentual ?? null };
}

// ── SAIR ──────────────────────────────────────────────────────────────────────
//
// Tira anúncios de UMA promoção — o "Deixar de participar" do painel do Mercado Livre.
//
// A chamada já era usada aqui dentro, escondida: para REDUZIR um desconto o ML exige
// sair e voltar, porque o PUT só aceita preço menor. Ou seja, este caminho já rodava
// em produção; só não havia como pedir por ele de fora.
//
// Sair não tem volta automática — o anúncio perde o desconto na hora. Quem confirma
// com o Matheus é a tela; esta função só executa.
async function sair(corpo: {
  conta: string; promocao_id: string; promocao_tipo: string; itens: string[];
}) {
  const { conta, promocao_id, promocao_tipo, itens } = corpo;
  const t = await token(conta);
  const auth = {
    Authorization: `Bearer ${t.access_token}`,
    'Content-Type': 'application/json',
  };

  const { data: cache } = await sb.from('ml_promocoes_itens')
    .select('item_id, title').eq('conta', conta).eq('promocao_id', promocao_id).in('item_id', itens);
  const titulos = new Map((cache ?? []).map((c) => [c.item_id, c.title]));

  const saidos: unknown[] = [];
  const recusados: unknown[] = [];

  for (const itemId of itens) {
    const r = await chamarComInsistencia(
      `https://api.mercadolibre.com/seller-promotions/items/${itemId}`
      + `?app_version=v2&promotion_type=${promocao_tipo}&promotion_id=${promocao_id}`,
      { method: 'DELETE', headers: auth },
    );

    // 404 = o ML diz que o anúncio já não está nesta promoção. Para quem clicou, o
    // resultado é o desejado — não é erro, é trabalho que já estava feito.
    if (r && (r.ok || r.status === 404)) {
      saidos.push({ item_id: itemId, title: titulos.get(itemId) ?? null });
      // Volta a ser candidato: continua elegível, só não está participando.
      await sb.from('ml_promocoes_itens')
        .update({ status: 'candidate', preco_promo: null })
        .eq('conta', conta).eq('promocao_id', promocao_id).eq('item_id', itemId);
    } else {
      const erro = r ? await r.json().catch(() => ({})) : null;
      const bruto = String(erro?.message ?? '') + (erro?.error ? ' ' + String(erro.error) : '');
      recusados.push({
        item_id: itemId, title: titulos.get(itemId) ?? null,
        motivo: bruto.trim() ? motivoEmPortugues(bruto)
          : r ? `o ML respondeu ${r.status}` : 'não consegui falar com o Mercado Livre',
      });
    }
  }

  const registros = [
    ...(saidos as { item_id: string; title: string | null }[]).map((s) => ({
      conta, item_id: s.item_id, title: s.title,
      acao: 'promocao_saiu',
      detalhe: `${promocao_tipo} ${promocao_id}: deixou de participar`,
      origem: 'site',
    })),
    ...(recusados as { item_id: string; title: string | null; motivo: string }[]).map((x) => ({
      conta, item_id: x.item_id, title: x.title,
      acao: 'promocao_saida_recusada',
      detalhe: `${promocao_tipo} ${promocao_id}: ${x.motivo}`.slice(0, 300),
      origem: 'site',
    })),
  ];
  if (registros.length) {
    await sb.from('ml_log_acoes').insert(registros).then(() => {}, () => {});
  }

  return { saidos, recusados };
}

// ── ENTRADA ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const url = new URL(req.url);
    const acao = url.searchParams.get('acao') ?? 'listar';

    if (acao === 'listar') {
      return json(await listar(url.searchParams.get('conta'), url.searchParams.get('promocao_id')));
    }

    if (acao === 'ativar') {
      if (req.method !== 'POST') return json({ erro: 'use POST' }, 405);
      return json(await ativar(await req.json()));
    }

    if (acao === 'sair') {
      if (req.method !== 'POST') return json({ erro: 'use POST' }, 405);
      return json(await sair(await req.json()));
    }

    if (acao === 'varrer') {
      return json({ erro: 'a varredura roda no robô — use o botão "atualizar lista" no site' }, 400);
    }

    return json({ erro: `ação desconhecida: ${acao}` }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
