// Preenche a tarifa REAL de cada anúncio no cache de promoções.
//
// A tarifa vinha da tabela pública do Mercado Livre (categoria + tipo de anúncio),
// consultada com um preço só. Comparando com o `sale_fee` dos pedidos — o valor que o
// ML de fato cobrou — a estimativa erra 2,17 pontos percentuais em média, e quase
// metade dos anúncios erra mais de 2 pontos. Num item de R$ 300 isso é R$ 6 por venda,
// direto no "Você recebe".
//
// Não chama API nenhuma: o sale_fee já vem dentro de cada pedido que o sistema guarda.
//
// DUAS FAIXAS, porque o ML cobra diferente acima e abaixo de R$ 79 (a mesma linha que
// separa o frete). Como o preço promocional pode cruzar essa linha — um item de R$ 85
// com 20% de desconto vai para R$ 68 — guardamos as duas e a tela escolhe pelo preço
// final de cada promoção.
//
// TRÊS FONTES, da mais firme para a mais fraca:
//   1. o que o próprio anúncio pagou                → "real"
//   2. a média da categoria dele                    → "categoria"
//   3. a estimativa da tabela do ML, que já existia → "tabela"
//
// Como usar:  node calcular-tarifas.js

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// A partir de quantas vendas a média do próprio anúncio se sustenta sozinha. Mesma
// régua do frete: uma ou duas vendas é o que aconteceu naquele dia, não uma média.
const MINIMO_DE_VENDAS = 3;
const CORTE = 79;

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

async function calcular({ log = console.log } = {}) {
  const sb = conectar();

  const porAnuncio = new Map();
  (await tudo(sb, 'ml_tarifa_por_anuncio', 'conta, item_id, pct_alto, pct_baixo, vendas_alto, vendas_baixo'))
    .forEach((r) => porAnuncio.set(`${r.conta}|${r.item_id}`, r));

  const porCategoria = new Map();
  (await tudo(sb, 'ml_tarifa_por_categoria', 'categoria, pct_alto, pct_baixo, vendas_alto, vendas_baixo'))
    .forEach((r) => porCategoria.set(r.categoria, r));

  const categoriaDoItem = new Map();
  (await tudo(sb, 'ml_anuncios', 'conta, item_id, category_id'))
    .forEach((r) => categoriaDoItem.set(`${r.conta}|${r.item_id}`, r.category_id));

  log(`  ${porAnuncio.size} anúncios com tarifa real · ${porCategoria.size} categorias com média`);

  const linhas = await tudo(sb, 'ml_promocoes_itens', 'id, conta, item_id, preco_cheio, tarifa_percentual');
  const contagem = { real: 0, categoria: 0, tabela: 0 };
  const atualizacoes = [];

  for (const l of linhas) {
    const chave = `${l.conta}|${l.item_id}`;
    const real = porAnuncio.get(chave);
    const cat = porCategoria.get(categoriaDoItem.get(chave));

    // Escolhe faixa a faixa: um anúncio pode ter histórico farto acima de R$ 79 e
    // nenhum abaixo. Nesse caso o alto vem do próprio anúncio e o baixo, da categoria.
    function escolher(campo, vendas) {
      if (real && real[campo] != null && real[vendas] >= MINIMO_DE_VENDAS) {
        return { valor: Number(real[campo]), origem: 'real', vendas: real[vendas] };
      }
      if (cat && cat[campo] != null && cat[vendas] >= MINIMO_DE_VENDAS) {
        return { valor: Number(cat[campo]), origem: 'categoria', vendas: null };
      }
      if (real && real[campo] != null) {
        return { valor: Number(real[campo]), origem: 'real', vendas: real[vendas] };
      }
      if (l.tarifa_percentual != null) {
        return { valor: Number(l.tarifa_percentual), origem: 'tabela', vendas: null };
      }
      return null;
    }

    const alto = escolher('pct_alto', 'vendas_alto');
    const baixo = escolher('pct_baixo', 'vendas_baixo');
    if (!alto && !baixo) continue;

    // Uma faixa sem dado nenhum usa a outra: melhor um número próximo do que nada,
    // que deixaria a coluna "Você recebe" em branco.
    const pctAlto = alto || baixo;
    const pctBaixo = baixo || alto;

    contagem[pctAlto.origem]++;
    atualizacoes.push({
      id: l.id,
      tarifa_pct_alto: pctAlto.valor,
      tarifa_pct_baixo: pctBaixo.valor,
      tarifa_origem: pctAlto.origem,
      tarifa_vendas: pctAlto.vendas,
    });
  }

  // Grava por grupo de valor, não linha a linha — mesmo motivo do frete: o valor se
  // repete muito e um update por linha seriam milhares de idas ao banco.
  const grupos = new Map();
  atualizacoes.forEach((a) => {
    const k = `${a.tarifa_pct_alto}|${a.tarifa_pct_baixo}|${a.tarifa_origem}|${a.tarifa_vendas ?? ''}`;
    if (!grupos.has(k)) grupos.set(k, { valor: a, ids: [] });
    grupos.get(k).ids.push(a.id);
  });

  for (const { valor, ids } of grupos.values()) {
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await sb.from('ml_promocoes_itens').update({
        tarifa_pct_alto: valor.tarifa_pct_alto,
        tarifa_pct_baixo: valor.tarifa_pct_baixo,
        tarifa_origem: valor.tarifa_origem,
        tarifa_vendas: valor.tarifa_vendas,
      }).in('id', ids.slice(i, i + 500));
      if (error) throw new Error(`falha ao gravar: ${error.message}`);
    }
  }

  log(`  ${atualizacoes.length} linhas atualizadas · ${grupos.size} valores distintos`);
  log(`     tarifa real do anúncio .. ${contagem.real}`);
  log(`     média da categoria ...... ${contagem.categoria}`);
  log(`     tabela do ML (estimada) . ${contagem.tabela}`);
  return contagem;
}

module.exports = { calcular, CORTE };

if (require.main === module) {
  calcular().then(() => console.log('')).catch((e) => {
    console.error('  ❌ ' + e.message); process.exit(1);
  });
}
