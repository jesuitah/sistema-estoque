// Varredura das promoções — descobre o que cada anúncio aceita e guarda no cache.
//
// POR QUE AQUI E NÃO NO SERVIDOR
// A API do Mercado Livre só responde "quais promoções este anúncio aceita" um anúncio
// por vez. São ~1.100 anúncios numa loja: a Edge Function estoura o tempo limite antes
// de terminar (testado: morreu em 37s). O robô não tem esse limite.
//
// NÃO USA NAVEGADOR. É tudo API oficial — não depende de sessão nem do painel.
//
// Como usar:  node promocoes.js            (todas as contas)
//             node promocoes.js KMP        (uma conta)

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONTAS = ['KMP', 'ERP', 'LTS'];

const NOMES_PADRAO = {
  PRICE_DISCOUNT: 'Desconto no anúncio',
  DEAL: 'Oferta com data',
  LIGHTNING: 'Oferta relâmpago',
  SMART: 'Impulsione suas vendas',
  UNHEALTHY_STOCK: 'Acelere as vendas do Full',
  SELLER_CAMPAIGN: 'Campanha da loja',
  SELLER_COUPON_CAMPAIGN: 'Cupom',
  PRICE_MATCHING: 'Cobrir concorrência',
};

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function idsAtivos(userId, auth) {
  const ids = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const r = await fetch(
      `https://api.mercadolibre.com/users/${userId}/items/search?status=active&limit=100&offset=${offset}`,
      { headers: auth });
    if (!r.ok) break;
    const lote = (await r.json()).results || [];
    ids.push(...lote);
    if (lote.length < 100) break;
  }
  return ids;
}

async function titulos(ids, auth) {
  const mapa = {};
  for (let i = 0; i < ids.length; i += 20) {
    const r = await fetch(
      `https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,title,available_quantity`,
      { headers: auth });
    if (!r.ok) continue;
    for (const x of await r.json()) {
      if (x.code === 200 && x.body) mapa[x.body.id] = x.body.title;
    }
  }
  return mapa;
}

async function varrerConta(sb, conta, log) {
  const { data: tok } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', conta).maybeSingle();
  if (!tok) { log(`  ${conta}: sem token, pulando`); return null; }
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const ids = await idsAtivos(tok.user_id, auth);
  log(`  ${conta}: ${ids.length} anúncios ativos`);
  const nomes = await titulos(ids, auth);

  const linhas = [];
  let erros = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2`,
        { headers: auth });
      if (!r.ok) { erros++; continue; }
      for (const p of await r.json()) {
        linhas.push({
          conta, item_id: id, title: nomes[id] || null,
          // PRICE_DISCOUNT não tem id de campanha (é o desconto avulso do anúncio).
          // Damos um id fixo pra ele virar uma aba como as outras.
          promocao_id: p.id || `PD-${p.type}`,
          promocao_tipo: p.type,
          promocao_sub: p.sub_type || null,
          promocao_nome: p.name || NOMES_PADRAO[p.type] || p.type,
          status: p.status,
          preco_cheio: p.original_price ?? null,
          preco_promo: p.price || null,
          preco_min: p.min_discounted_price ?? null,
          preco_max: p.max_discounted_price ?? null,
          preco_sugerido: p.suggested_discounted_price ?? null,
          meli_percentual: p.meli_percentage ?? null,
          vendedor_percentual: p.seller_percentage ?? null,
        });
      }
    } catch (_e) { erros++; }

    if ((i + 1) % 100 === 0) {
      log(`  ${conta}: ${i + 1}/${ids.length}`);
      await sb.from('robo_status').update({
        detalhe: { varrendo_promocoes: true, conta, lidos: i + 1, total: ids.length },
      }).eq('id', 1).then(() => {}, () => {});
    }
  }

  // Troca o cache desta conta de uma vez só, pra tela nunca ver meio caminho.
  await sb.from('ml_promocoes_itens').delete().eq('conta', conta);
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await sb.from('ml_promocoes_itens').insert(linhas.slice(i, i + 500));
    if (error) throw new Error(`falha ao gravar o cache: ${error.message}`);
  }

  log(`  ${conta}: ${linhas.length} oportunidades de promoção${erros ? ` · ${erros} anúncios não responderam` : ''}`);
  return { conta, anuncios: ids.length, oportunidades: linhas.length, erros };
}

async function varrer({ contas = CONTAS, log = console.log } = {}) {
  const sb = conectar();
  const saida = [];
  for (const conta of contas) {
    const r = await varrerConta(sb, conta, log).catch((e) => {
      log(`  ${conta}: falhou — ${e.message}`);
      return null;
    });
    if (r) saida.push(r);
  }
  await sb.from('robo_status').update({ detalhe: null }).eq('id', 1).then(() => {}, () => {});
  return saida;
}

module.exports = { varrer };

if (require.main === module) {
  const conta = process.argv[2] ? [process.argv[2].toUpperCase()] : CONTAS;
  varrer({ contas: conta }).then((r) => {
    console.log('\n  ' + JSON.stringify(r));
  }).catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
}
