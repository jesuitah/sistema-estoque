// Busca no Mercado Livre o frete OFICIAL de cada anúncio.
//
// POR QUE ISTO EXISTE
// O custo do frete vinha sendo estimado — primeiro pela média da categoria, depois pela
// mediana da faixa de preço. As duas erravam, e o Matheus pegou comparando a tela com o
// painel do ML. A causa era boba: eu estava adivinhando um número que o ML entrega
// pronto.
//
//   GET /items/{id}/shipping_options?zip_code=XXX  →  options[].list_cost
//
// `list_cost` é o que o VENDEDOR paga; `cost` é o que o comprador paga (zero, quando o
// frete é grátis). Conferido nos dois anúncios que ele mandou: 24,45 e 12,95 — os mesmos
// valores do painel. Não é média: é a tabela do ML para aquele anúncio, já considerando
// peso e dimensões.
//
// O CEP é fixo porque o frete grátis que o vendedor paga não varia com o destino — o que
// varia é o que o comprador pagaria. Usamos São Paulo capital como referência.
//
// Como usar:  node coletar-frete-oficial.js          (só o que falta)
//             node coletar-frete-oficial.js --tudo   (refaz todos)

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CEP_REFERENCIA = '01310100';   // Av. Paulista
const CONTAS = ['KMP', 'ERP', 'LTS'];

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function buscar(url, opcoes = {}, segundos = 20) {
  const abortar = new AbortController();
  const relogio = setTimeout(() => abortar.abort(), segundos * 1000);
  try {
    return await fetch(url, { ...opcoes, signal: abortar.signal });
  } finally {
    clearTimeout(relogio);
  }
}

async function tudo(sb, tabela, colunas, filtro) {
  let saida = [];
  for (let i = 0; ; i += 1000) {
    let q = sb.from(tabela).select(colunas).range(i, i + 999);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tabela}: ${error.message}`);
    if (!data || !data.length) break;
    saida = saida.concat(data);
    if (data.length < 1000) break;
  }
  return saida;
}

// O ML devolve várias opções de envio — é o CARDÁPIO mostrado ao comprador, uma linha
// por modalidade (normal, expressa, agendada...). O que o vendedor paga é a modalidade
// padrão, a mais barata; as caras são as entregas rápidas, que o comprador escolhe e
// paga a diferença.
//
// Antes eu pegava o valor MAIS REPETIDO, e isso estava errado de um jeito caro.
//
// Prova: dois anúncios do MESMO produto (HITECH HT-11000), mesmo peso, mesmas
// dimensões, os dois no Full, mesmo preço de R$ 17,53.
//   • um só oferecia uma opção → R$ 10,99
//   • o outro oferecia onze, sete delas a R$ 23,99 → o "mais repetido" dava R$ 23,99
// O sistema mostrava que esse segundo anúncio dava PREJUÍZO de R$ 11,19 por venda.
//
// As vendas reais desmentem: em 17 vendas desses anúncios o frete mais caro que o
// Matheus pagou foi R$ 12,50. Nunca R$ 23,99.
//
// A regra abaixo (a mais barata) devolve R$ 10,99 nos dois — que é o que os dois
// anúncios idênticos têm de fato que custar.
function custoDoVendedor(opcoes) {
  let menor = null;
  for (const o of opcoes || []) {
    if (o.list_cost == null) continue;
    const v = Number(o.list_cost);
    if (menor == null || v < menor) menor = v;
  }
  return menor;
}

async function coletar({ tudoDeNovo = false, log = console.log } = {}) {
  const sb = conectar();
  const resumo = [];

  for (const conta of CONTAS) {
    const { data: tok, error: erroTok } = await sb.from('ml_tokens')
      .select('access_token').eq('conta', conta).maybeSingle();
    if (erroTok) throw new Error(`não consegui ler o token de ${conta}: ${erroTok.message}`);
    if (!tok) { log(`  ${conta}: sem token cadastrado, pulando`); continue; }
    const auth = { Authorization: `Bearer ${tok.access_token}` };

    // Só os anúncios que aparecem em alguma promoção — é onde o número é usado.
    const linhas = await tudo(sb, 'ml_promocoes_itens', 'item_id',
      (q) => q.eq('conta', conta));
    const itens = [...new Set(linhas.map((l) => l.item_id))];

    const jaTemos = new Set();
    if (!tudoDeNovo) {
      (await tudo(sb, 'ml_frete_anuncio', 'item_id', (q) => q.eq('conta', conta)))
        .forEach((r) => jaTemos.add(r.item_id));
    }
    const faltam = itens.filter((i) => !jaTemos.has(i));

    log(`  ${conta}: ${itens.length} anúncios · ${faltam.length} a buscar`);
    if (!faltam.length) { resumo.push({ conta, novos: 0 }); continue; }

    const achados = [];
    let erros = 0;
    for (let i = 0; i < faltam.length; i++) {
      try {
        const r = await buscar(
          `https://api.mercadolibre.com/items/${faltam[i]}/shipping_options?zip_code=${CEP_REFERENCIA}`,
          { headers: auth });
        if (!r.ok) { erros++; continue; }
        const custo = custoDoVendedor((await r.json()).options);
        if (custo == null) { erros++; continue; }
        achados.push({ conta, item_id: faltam[i], custo, atualizado_em: new Date().toISOString() });
      } catch (_e) { erros++; }

      if ((i + 1) % 200 === 0) log(`  ${conta}: ${i + 1}/${faltam.length}`);
    }

    for (let i = 0; i < achados.length; i += 500) {
      const { error } = await sb.from('ml_frete_anuncio')
        .upsert(achados.slice(i, i + 500), { onConflict: 'conta,item_id' });
      if (error) throw new Error(`falha ao gravar: ${error.message}`);
    }
    log(`  ${conta}: ${achados.length} fretes oficiais${erros ? ` · ${erros} não responderam` : ''}`);
    resumo.push({ conta, novos: achados.length, erros });
  }

  // Copia para o cache de promoções, que é o que a tela lê.
  const fretes = await tudo(sb, 'ml_frete_anuncio', 'conta, item_id, custo');
  const porValor = new Map();
  fretes.forEach((f) => {
    const k = `${f.conta}|${f.custo}`;
    if (!porValor.has(k)) porValor.set(k, { conta: f.conta, custo: f.custo, itens: [] });
    porValor.get(k).itens.push(f.item_id);
  });
  for (const g of porValor.values()) {
    for (let i = 0; i < g.itens.length; i += 300) {
      await sb.from('ml_promocoes_itens')
        .update({ frete_oficial: g.custo })
        .eq('conta', g.conta).in('item_id', g.itens.slice(i, i + 300));
    }
  }
  log(`  ${fretes.length} anúncios com frete oficial no cache`);
  return resumo;
}

module.exports = { coletar };

if (require.main === module) {
  coletar({ tudoDeNovo: process.argv.includes('--tudo') })
    .then((r) => console.log('\n  ' + JSON.stringify(r) + '\n'))
    .catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
}
