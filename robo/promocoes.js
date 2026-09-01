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

// Toda chamada tem prazo.
//
// Sem isto, uma única requisição pendurada congela o robô INTEIRO: a varredura roda
// dentro do laço principal, então nada mais anda — nem as tarefas que o Matheus
// mandou. Aconteceu de verdade: travou em 450 de 493 e ficou 35 minutos parado.
async function buscar(url, opcoes = {}, segundos = 20) {
  const abortar = new AbortController();
  const relogio = setTimeout(() => abortar.abort(), segundos * 1000);
  try {
    return await fetch(url, { ...opcoes, signal: abortar.signal });
  } finally {
    clearTimeout(relogio);
  }
}

// A varredura demora minutos. Se o Matheus mandar uma tarefa nesse meio tempo, ela
// espera a varredura acabar — o que é errado: a fila dele vem primeiro.
async function temTarefaDoMatheus(sb) {
  const { data } = await sb.from('ml_tarefas_robo')
    .select('id').eq('status', 'pendente')
    .not('tipo', 'in', '("patrulha_agora","varrer_promocoes")').limit(1);
  return !!(data && data.length);
}

async function idsAtivos(userId, auth) {
  const ids = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const r = await buscar(
      `https://api.mercadolibre.com/users/${userId}/items/search?status=active&limit=100&offset=${offset}`,
      { headers: auth });
    if (!r.ok) break;
    const lote = (await r.json()).results || [];
    ids.push(...lote);
    if (lote.length < 100) break;
  }
  return ids;
}

// Título e SKU de cada anúncio. O SKU é o que o Matheus usa pra reconhecer a peça —
// sem ele a lista vira um monte de título parecido.
//
// O SKU NÃO está em `seller_custom_field` (vem nulo nesta conta): ele vive no atributo
// SELLER_SKU. Foi verificado num anúncio real antes de escrever isto.
async function dadosDosAnuncios(ids, auth) {
  const mapa = {};
  for (let i = 0; i < ids.length; i += 20) {
    const r = await buscar(
      `https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(',')}`
      + `&attributes=id,title,seller_custom_field,attributes,category_id,listing_type_id,shipping,price`,
      { headers: auth });
    if (!r.ok) continue;
    for (const x of await r.json()) {
      if (x.code !== 200 || !x.body) continue;
      const attr = (x.body.attributes || []).find((a) => a.id === 'SELLER_SKU');
      const sku = attr ? (attr.value_name || (attr.values && attr.values[0] && attr.values[0].name)) : null;
      mapa[x.body.id] = {
        title: x.body.title,
        sku: sku || x.body.seller_custom_field || null,
        categoria: x.body.category_id || null,
        tipoAnuncio: x.body.listing_type_id || null,
        freteGratis: !!(x.body.shipping && x.body.shipping.free_shipping),
        preco: x.body.price,
      };
    }
  }
  return mapa;
}

// TARIFA DE VENDA
//
// Quanto o ML cobra depende da CATEGORIA e do TIPO do anúncio, não do anúncio em si.
// Então perguntamos uma vez por combinação e reaproveitamos — são poucas dezenas de
// combinações pra mais de mil anúncios. Perguntar item a item seria mil chamadas pelo
// mesmo resultado.
async function tarifaDe(sb, cache, categoria, tipo, preco, auth) {
  if (!categoria || !tipo) return null;
  const chave = `${categoria}|${tipo}`;
  if (cache[chave] !== undefined) return cache[chave];

  const { data } = await sb.from('ml_tarifas')
    .select('percentual, taxa_fixa').eq('categoria', categoria).eq('tipo_anuncio', tipo).maybeSingle();
  if (data) {
    cache[chave] = { percentual: Number(data.percentual), fixa: Number(data.taxa_fixa) };
    return cache[chave];
  }

  const r = await buscar(
    `https://api.mercadolibre.com/sites/MLB/listing_prices?price=${preco}`
    + `&listing_type_id=${tipo}&category_id=${categoria}`,
    { headers: auth }).catch(() => null);
  if (!r || !r.ok) { cache[chave] = null; return null; }

  const j = await r.json();
  const pct = j.sale_fee_details?.percentage_fee;
  if (pct == null) { cache[chave] = null; return null; }

  cache[chave] = { percentual: Number(pct), fixa: Number(j.sale_fee_details?.fixed_fee || 0) };
  await sb.from('ml_tarifas').upsert({
    categoria, tipo_anuncio: tipo,
    percentual: cache[chave].percentual, taxa_fixa: cache[chave].fixa,
    atualizado_em: new Date().toISOString(),
  }).then(() => {}, () => {});
  return cache[chave];
}

async function varrerConta(sb, conta, log) {
  const { data: tok } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', conta).maybeSingle();
  if (!tok) { log(`  ${conta}: sem token, pulando`); return null; }
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const ids = await idsAtivos(tok.user_id, auth);
  log(`  ${conta}: ${ids.length} anúncios ativos`);
  const dados = await dadosDosAnuncios(ids, auth);

  const linhas = [];
  const cacheTarifa = {};
  let erros = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const d = dados[id] || {};
    try {
      const r = await buscar(
        `https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2`,
        { headers: auth });
      if (!r.ok) { erros++; continue; }

      // Tarifa do anúncio, pra tela conseguir mostrar quanto sobra em cada promoção.
      const tarifa = await tarifaDe(sb, cacheTarifa, d.categoria, d.tipoAnuncio, d.preco, auth);

      for (const p of await r.json()) {
        linhas.push({
          conta, item_id: id,
          title: d.title || null,
          sku: d.sku || null,
          tarifa_percentual: tarifa ? tarifa.percentual : null,
          tarifa_fixa: tarifa ? tarifa.fixa : null,
          frete_gratis: d.freteGratis ?? null,
          // Quando a promoção começa e acaba. O ML manda em formatos diferentes
          // conforme o tipo; guardamos como veio e a tela formata.
          data_inicio: p.start_date || null,
          data_fim: p.finish_date || p.deadline_date || null,
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

    // Bate ponto junto com o progresso.
    //
    // A varredura trava o laço principal do robô por vários minutos. Sem atualizar a
    // ultima_batida aqui, o site conclui que o robô morreu e mostra "Robô desligado"
    // bem enquanto ele está trabalhando — foi o que aconteceu na primeira vez.
    if ((i + 1) % 25 === 0) {
      if ((i + 1) % 100 === 0) log(`  ${conta}: ${i + 1}/${ids.length}`);
      await sb.from('robo_status').update({
        ultima_batida: new Date().toISOString(),
        detalhe: { varrendo_promocoes: true, conta, lidos: i + 1, total: ids.length },
      }).eq('id', 1).then(() => {}, () => {});

      // Chegou tarefa do Matheus? Ela vem primeiro. Interrompemos a varredura sem
      // gravar nada — o cache antigo continua valendo e a varredura recomeça depois.
      if (await temTarefaDoMatheus(sb)) {
        log(`  ${conta}: tarefa na fila — interrompendo a varredura pra atender`);
        return { conta, anuncios: ids.length, interrompida: true };
      }
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

module.exports = { varrer, CONTAS };

if (require.main === module) {
  const conta = process.argv[2] ? [process.argv[2].toUpperCase()] : CONTAS;
  varrer({ contas: conta }).then((r) => {
    console.log('\n  ' + JSON.stringify(r));
  }).catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
}
