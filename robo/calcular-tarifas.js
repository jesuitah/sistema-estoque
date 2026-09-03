// Preenche a tarifa de venda do Mercado Livre por CATEGORIA e FAIXA DE PREÇO.
//
// DUAS LIÇÕES QUE CUSTARAM CARO, as duas pegas pelo Matheus comparando a tela com o
// painel do ML:
//
// 1. A fonte é a TABELA OFICIAL, não o histórico de vendas. Cheguei a trocar por uma
//    média do `sale_fee` dos pedidos achando que seria "o valor real". Mas o sale_fee
//    de uma venda já vem com as REDUÇÕES que valiam naquele dia (a Impulsione abate
//    parte da tarifa) — é o que ele pagou, não o que vai pagar.
//
// 2. A tarifa MUDA COM O PREÇO, não é uma por categoria. Na MLB63829 são 17% até
//    R$ 149,99, 14% de R$ 150 a R$ 699,99, e 17% de novo acima de R$ 700. Na MLB47115
//    são 17% em todas as faixas. Não dá pra supor: tem que perguntar faixa por faixa.
//    Como o desconto muda o preço final, a faixa pode mudar junto — por isso a tela
//    escolhe pelo preço FINAL de cada promoção, não pelo cheio.
//
// Uma consulta por (categoria, faixa) serve para todos os anúncios dela.
//
// Como usar:  node calcular-tarifas.js

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Os cortes foram achados por busca binária na própria API do ML.
const FAIXAS = [5, 150, 700, 999999];
const TIPO = 'gold_pro';   // todos os anúncios das 3 lojas são Premium

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function tudo(sb, tabela, colunas) {
  let saida = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from(tabela).select(colunas).range(i, i + 999);
    if (error) throw new Error(`${tabela}: ${error.message}`);
    if (!data || !data.length) break;
    saida = saida.concat(data);
    if (data.length < 1000) break;
  }
  return saida;
}

// Um preço que cai dentro da faixa, para perguntar ao ML.
function precoDaFaixa(ate, anterior) {
  if (ate >= 999999) return 1200;
  return Math.round(((anterior + ate) / 2) * 100) / 100;
}

async function calcular({ log = console.log } = {}) {
  const sb = conectar();

  const { data: tok, error: erroTok } = await sb.from('ml_tokens').select('conta, access_token');
  if (erroTok) throw new Error(`não consegui ler os tokens: ${erroTok.message}`);
  const algumToken = (tok || [])[0] && tok[0].access_token;
  if (!algumToken) throw new Error('nenhuma conta com token');

  const jaTemos = new Set(
    (await tudo(sb, 'ml_tarifas', 'categoria, tipo_anuncio, ate_preco'))
      .map((t) => `${t.categoria}|${t.tipo_anuncio}|${t.ate_preco}`));

  const dadosDoItem = new Map();
  (await tudo(sb, 'ml_anuncios', 'conta, item_id, category_id'))
    .forEach((r) => dadosDoItem.set(`${r.conta}|${r.item_id}`, r.category_id));

  const linhas = await tudo(sb, 'ml_promocoes_itens', 'id, conta, item_id');

  // Só as categorias que realmente aparecem nas promoções.
  const categorias = new Set();
  linhas.forEach((l) => {
    const c = dadosDoItem.get(`${l.conta}|${l.item_id}`);
    if (c) categorias.add(c);
  });

  let novas = 0;
  for (const categoria of categorias) {
    let anterior = 0;
    for (const ate of FAIXAS) {
      const chave = `${categoria}|${TIPO}|${Number(ate).toFixed(2)}`;
      if (jaTemos.has(chave)) { anterior = ate; continue; }
      try {
        const r = await fetch(
          `https://api.mercadolibre.com/sites/MLB/listing_prices?price=${precoDaFaixa(ate, anterior)}`
          + `&listing_type_id=${TIPO}&category_id=${categoria}`,
          { headers: { Authorization: `Bearer ${algumToken}` } });
        if (r.ok) {
          const j = await r.json();
          const pct = j.sale_fee_details?.percentage_fee;
          if (pct != null) {
            await sb.from('ml_tarifas').upsert({
              categoria, tipo_anuncio: TIPO, ate_preco: ate,
              percentual: Number(pct), taxa_fixa: Number(j.sale_fee_details?.fixed_fee || 0),
              atualizado_em: new Date().toISOString(),
            });
            novas++;
          }
        }
      } catch (_e) { /* segue para a próxima faixa */ }
      anterior = ate;
    }
  }
  log(`  ${categorias.size} categorias · ${novas} faixa(s) de tarifa consultada(s) no ML`);

  // Grava a categoria no cache de promoções, para a tela achar a tarifa sem cruzar
  // tabela nenhuma.
  const porCategoria = new Map();
  linhas.forEach((l) => {
    const c = dadosDoItem.get(`${l.conta}|${l.item_id}`) || null;
    if (!porCategoria.has(c)) porCategoria.set(c, []);
    porCategoria.get(c).push(l.id);
  });

  for (const [categoria, ids] of porCategoria) {
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await sb.from('ml_promocoes_itens')
        .update({ categoria })
        .in('id', ids.slice(i, i + 500));
      if (error) throw new Error(`falha ao gravar a categoria: ${error.message}`);
    }
  }
  const semCategoria = (porCategoria.get(null) || []).length;
  log(`  ${linhas.length - semCategoria} linhas com categoria${semCategoria ? ` · ${semCategoria} sem` : ''}`);

  return { categorias: categorias.size, faixas: novas, sem_categoria: semCategoria };
}

// Recalcula a tabela de frete por faixa de preço a partir das vendas reais.
async function atualizarFaixasDeFrete({ log = console.log } = {}) {
  const sb = conectar();
  const { data, error } = await sb.from('ml_frete_faixas_calculada').select('*');
  if (error) throw new Error(`faixas de frete: ${error.message}`);
  if (!data || !data.length) { log('  sem vendas suficientes para recalcular as faixas'); return []; }
  for (const f of data) {
    await sb.from('ml_frete_faixas').upsert({
      ate_preco: f.ate_preco, custo: f.custo, vendas: f.vendas,
      atualizado_em: new Date().toISOString(),
    });
  }
  log(`  frete: ${data.length} faixas de preço atualizadas`);
  return data;
}

module.exports = { calcular, atualizarFaixasDeFrete };

if (require.main === module) {
  (async () => {
    await atualizarFaixasDeFrete({});
    await calcular({});
    console.log('');
  })().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
}
