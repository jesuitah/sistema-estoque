// Preenche o custo de frete de cada anúncio no cache de promoções.
//
// A tela precisa disso pra coluna "Você recebe" descontar o frete. O cálculo mora aqui
// e não na tela porque envolve três fontes e um cruzamento por categoria — fazer isso
// no navegador a cada clique deixaria a aba lenta à toa.
//
// TRÊS FONTES, da mais firme para a mais fraca:
//   1. o que o próprio anúncio já custou nas vendas dele        → "real"
//   2. a média da categoria dele                                 → "categoria"
//   3. a média geral da faixa de preço                           → "faixa"
//
// A distinção importa: o Matheus precisa saber quando o número é fato e quando é
// estimativa. Só 42% dos anúncios já venderam nestes dois meses.
//
// Como usar:  node calcular-fretes.js

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
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

// O corte dos R$ 79 é real e foi medido: abaixo dele o frete fica em ~R$ 7; de 79 pra
// cima pula pra ~R$ 23. Serve de último recurso, quando não há nem categoria.
const FAIXA_BARATA = 6.73;
const FAIXA_CARA = 22.68;
const CORTE = 79;

// A partir de quantas vendas a média do próprio anúncio se sustenta sozinha.
const MINIMO_DE_VENDAS = 3;

async function calcular({ log = console.log } = {}) {
  const sb = conectar();

  const porAnuncio = new Map();
  (await tudo(sb, 'ml_frete_por_anuncio', 'conta, item_id, custo, vendas'))
    .forEach((r) => porAnuncio.set(`${r.conta}|${r.item_id}`, r));

  const porCategoria = new Map();
  (await tudo(sb, 'ml_frete_por_categoria', 'categoria, custo, vendas'))
    .forEach((r) => porCategoria.set(r.categoria, r));

  // A categoria de cada anúncio mora no cadastro, não no cache de promoções.
  const categoriaDoItem = new Map();
  (await tudo(sb, 'ml_anuncios', 'conta, item_id, category_id'))
    .forEach((r) => categoriaDoItem.set(`${r.conta}|${r.item_id}`, r.category_id));

  log(`  ${porAnuncio.size} anúncios com frete real · ${porCategoria.size} categorias com média`);

  const linhas = await tudo(sb, 'ml_promocoes_itens', 'id, conta, item_id, preco_cheio');
  const contagem = { real: 0, categoria: 0, faixa: 0 };
  const atualizacoes = [];

  for (const l of linhas) {
    const chave = `${l.conta}|${l.item_id}`;
    let custo = null, origem = null, vendas = null;

    const real = porAnuncio.get(chave);
    const cat = porCategoria.get(categoriaDoItem.get(chave));

    // Média de uma ou duas vendas não é média — é o que aconteceu naquele dia.
    //
    // Um Radiador Toyota Etios de R$ 728 apareceu com "R$ 9,90 real", de uma venda só:
    // foi uma venda turbo, com condição especial. Levar isso pra tela seria mostrar
    // margem que não existe. Então, com menos de 3 vendas, o valor real só vale se
    // estiver perto do que a categoria pratica; longe disso, a categoria manda.
    const poucasVendas = real && real.vendas < MINIMO_DE_VENDAS;
    const destoa = real && cat
      && (Number(real.custo) < Number(cat.custo) * 0.5 || Number(real.custo) > Number(cat.custo) * 2);

    if (real && !(poucasVendas && destoa)) {
      custo = Number(real.custo); origem = 'real'; vendas = real.vendas;
    } else if (cat) {
      custo = Number(cat.custo); origem = 'categoria';
    } else if (real) {
      custo = Number(real.custo); origem = 'real'; vendas = real.vendas;
    } else {
      custo = Number(l.preco_cheio) < CORTE ? FAIXA_BARATA : FAIXA_CARA;
      origem = 'faixa';
    }

    contagem[origem]++;
    atualizacoes.push({ id: l.id, frete_custo: custo, frete_origem: origem, frete_vendas: vendas });
  }

  // Grava por GRUPO de valor, não linha a linha.
  //
  // upsert não serve aqui: ele quer a linha inteira e reclama das colunas obrigatórias
  // que não estamos mandando. E um update por linha seriam ~3.000 idas ao banco. Como
  // o custo se repete muito (a média de uma categoria vale para dezenas de anúncios),
  // agrupamos por valor e mandamos um update por grupo — dá algumas dezenas.
  const grupos = new Map();
  atualizacoes.forEach((a) => {
    const chave = `${a.frete_custo}|${a.frete_origem}|${a.frete_vendas ?? ''}`;
    if (!grupos.has(chave)) grupos.set(chave, { valor: a, ids: [] });
    grupos.get(chave).ids.push(a.id);
  });

  for (const { valor, ids } of grupos.values()) {
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await sb.from('ml_promocoes_itens')
        .update({
          frete_custo: valor.frete_custo,
          frete_origem: valor.frete_origem,
          frete_vendas: valor.frete_vendas,
        })
        .in('id', ids.slice(i, i + 500));
      if (error) throw new Error(`falha ao gravar: ${error.message}`);
    }
  }
  log(`  ${grupos.size} valores distintos de frete`);

  log(`  ${atualizacoes.length} linhas atualizadas`);
  log(`     custo real do anúncio ... ${contagem.real}`);
  log(`     média da categoria ...... ${contagem.categoria}`);
  log(`     média da faixa de preço . ${contagem.faixa}`);
  return contagem;
}

module.exports = { calcular };

if (require.main === module) {
  calcular().then(() => console.log('')).catch((e) => {
    console.error('  ❌ ' + e.message); process.exit(1);
  });
}
