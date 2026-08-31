// Central de Promoções — tudo pela API oficial do Mercado Livre.
//
// Não usa o painel nem o robô do PC: são chamadas oficiais, então funciona mesmo com
// o computador do Matheus desligado.
//
// TRÊS AÇÕES
//   ?acao=varrer            relê o que cada anúncio aceita e atualiza o cache
//   ?acao=listar            devolve as promoções e os anúncios (lê só o cache, é instantâneo)
//   POST ?acao=ativar       coloca uma lista de anúncios numa promoção com um % de desconto
//
// POR QUE UM CACHE
// A API só responde "quais promoções este anúncio aceita" UM anúncio por vez. Com ~500
// anúncios por loja, perguntar na hora deixaria a tela inutilizável. Então varremos de
// tempos em tempos e a tela lê o cache.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CONTAS = ['KMP', 'ERP', 'LTS'];

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

async function token(conta: string) {
  const { data } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', conta).maybeSingle();
  if (!data) throw new Error(`conta ${conta} sem token`);
  return data;
}

// ── VARRER ────────────────────────────────────────────────────────────────────
// Pergunta a cada anúncio ativo quais promoções ele aceita e guarda no cache.
async function varrer(contas: string[]) {
  const resumo: Record<string, unknown> = {};

  for (const conta of contas) {
    const t = await token(conta);
    const auth = { Authorization: `Bearer ${t.access_token}` };

    // 1) todos os anúncios ativos da conta
    const ids: string[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const r = await fetch(
        `https://api.mercadolibre.com/users/${t.user_id}/items/search?status=active&limit=100&offset=${offset}`,
        { headers: auth });
      if (!r.ok) break;
      const j = await r.json();
      const lote = j.results ?? [];
      ids.push(...lote);
      if (lote.length < 100) break;
    }

    // 2) títulos, pra tela não mostrar só código
    const titulos: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 20) {
      const r = await fetch(
        `https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,title`,
        { headers: auth });
      if (!r.ok) continue;
      for (const x of await r.json()) {
        if (x.code === 200 && x.body) titulos[x.body.id] = x.body.title;
      }
    }

    // 3) promoções aceitas por anúncio
    const linhas: Record<string, unknown>[] = [];
    let erros = 0;
    for (const id of ids) {
      try {
        const r = await fetch(
          `https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2`,
          { headers: auth });
        if (!r.ok) { erros++; continue; }
        for (const p of await r.json()) {
          // PRICE_DISCOUNT não tem id de campanha; é o desconto avulso do próprio
          // anúncio. Guardamos com um id fixo pra ele virar uma "aba" também.
          const promocaoId = p.id ?? `PD-${p.type}`;
          linhas.push({
            conta, item_id: id, title: titulos[id] ?? null,
            promocao_id: promocaoId,
            promocao_tipo: p.type,
            promocao_sub: p.sub_type ?? null,
            promocao_nome: p.name || nomePadrao(p.type),
            status: p.status,
            preco_cheio: p.original_price ?? null,
            preco_promo: p.price || null,
            preco_min: p.min_discounted_price ?? null,
            preco_max: p.max_discounted_price ?? null,
            preco_sugerido: p.suggested_discounted_price ?? null,
            meli_percentual: p.meli_percentage ?? null,
            vendedor_percentual: p.seller_percentage ?? null,
            atualizado_em: new Date().toISOString(),
          });
        }
      } catch (_e) { erros++; }
    }

    // 4) troca o cache desta conta de uma vez
    await sb.from('ml_promocoes_itens').delete().eq('conta', conta);
    for (let i = 0; i < linhas.length; i += 500) {
      await sb.from('ml_promocoes_itens').insert(linhas.slice(i, i + 500));
    }

    resumo[conta] = { anuncios: ids.length, oportunidades: linhas.length, erros };
  }

  return resumo;
}

function nomePadrao(tipo: string) {
  const nomes: Record<string, string> = {
    PRICE_DISCOUNT: 'Desconto no anúncio',
    DEAL: 'Oferta com data',
    LIGHTNING: 'Oferta relâmpago',
    SMART: 'Impulsione suas vendas',
    UNHEALTHY_STOCK: 'Acelere as vendas do Full',
    SELLER_CAMPAIGN: 'Campanha da loja',
    SELLER_COUPON_CAMPAIGN: 'Cupom',
    PRICE_MATCHING: 'Cobrir concorrência',
  };
  return nomes[tipo] ?? tipo;
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

// ── ATIVAR ────────────────────────────────────────────────────────────────────
//
// Aplica UM percentual a uma lista de anúncios. O percentual é sempre sobre o preço
// cheio, como o Matheus trabalha.
//
// Quem não aceita o percentual NÃO é ajustado por conta própria: é devolvido na lista
// de recusados, com o motivo. Mexer no preço por conta própria seria decidir no lugar
// dele.
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

    // Promoções com percentual definido pelo ML não aceitam preço: é só entrar.
    const temPrecoLivre = info.preco_min != null && info.preco_max != null;
    if (temPrecoLivre) {
      if (!percentual) { recusados.push({ item_id: itemId, title: info.title, motivo: 'esta promoção precisa de um percentual' }); continue; }
      const cheio = Number(info.preco_cheio);
      const preco = Math.round(cheio * (1 - percentual / 100) * 100) / 100;

      if (preco > Number(info.preco_max)) {
        recusados.push({
          item_id: itemId, title: info.title,
          motivo: `${percentual}% é pouco — o mínimo aqui é ${percentualDe(cheio, info.preco_max)}%`,
        });
        continue;
      }
      if (preco < Number(info.preco_min)) {
        recusados.push({
          item_id: itemId, title: info.title,
          motivo: `${percentual}% é demais — o máximo aqui é ${percentualDe(cheio, info.preco_min)}%`,
        });
        continue;
      }
      payload.deal_price = preco;
    }

    const r = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${itemId}?app_version=v2`, {
      method: 'POST', headers: auth, body: JSON.stringify(payload),
    });

    if (r.ok) {
      ativados.push({ item_id: itemId, title: info.title, preco: payload.deal_price ?? null });
    } else {
      const e = await r.json().catch(() => ({}));
      recusados.push({ item_id: itemId, title: info.title, motivo: e.message ?? `o ML respondeu ${r.status}` });
    }
  }

  // O cache envelheceu para estes anúncios: marca como ativos os que entraram.
  for (const a of ativados as { item_id: string; preco: number | null }[]) {
    await sb.from('ml_promocoes_itens')
      .update({ status: 'started', preco_promo: a.preco })
      .eq('conta', conta).eq('promocao_id', promocao_id).eq('item_id', a.item_id);
  }

  return { ativados, recusados };
}

function percentualDe(cheio: number, preco: number) {
  return Math.round((1 - Number(preco) / cheio) * 1000) / 10;
}

// ── ENTRADA ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const url = new URL(req.url);
    const acao = url.searchParams.get('acao') ?? 'listar';

    if (acao === 'varrer') {
      const conta = url.searchParams.get('conta');
      return json(await varrer(conta ? [conta] : CONTAS));
    }

    if (acao === 'listar') {
      return json(await listar(url.searchParams.get('conta'), url.searchParams.get('promocao_id')));
    }

    if (acao === 'ativar') {
      if (req.method !== 'POST') return json({ erro: 'use POST' }, 405);
      return json(await ativar(await req.json()));
    }

    return json({ erro: `ação desconhecida: ${acao}` }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
