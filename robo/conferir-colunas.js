// DIAGNÓSTICO — só leitura. NÃO CLICA EM NADA.
//
// Responde a uma pergunta: o robô está enxergando a coluna certa?
// A patrulha lê a "ação sugerida" da coluna 8, um número fixo no código. Se o
// Mercado Livre mudar a tabela, ele passa a ler a coluna errada, acha "nada a
// fazer" pra sempre e continua parecendo saudável. Aqui despejamos o conteúdo
// real de cada coluna pra comparar.
//
// Como usar:  node conferir-colunas.js KMP

const { abrirNavegador } = require('./navegador');

const PAINEL = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  console.log(`\n  Lendo a tela do Full da ${conta} — sem clicar em nada\n`);

  const navegador = await abrirNavegador(conta);
  try {
    const pagina = navegador.pages()[0] || (await navegador.newPage());
    await pagina.goto(PAINEL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pagina.waitForFunction(
      () => /C[óo]digo ML/i.test(document.body.innerText || ''),
      { timeout: 45000 }
    ).catch(() => {});
    await pagina.waitForTimeout(2000);

    const r = await pagina.evaluate(() => {
      const limpar = (s) => (s || '').trim().replace(/\s+/g, ' ');
      const cabecalho = [...document.querySelectorAll('thead th, table tr:first-child th')]
        .map((x) => limpar(x.innerText));
      const linhas = [...document.querySelectorAll('tr')].slice(1)
        .map((tr) => [...tr.querySelectorAll('td,th')].map((x) => limpar(x.innerText)))
        .filter((c) => /C[óo]digo ML/i.test(c[0] || ''));
      return {
        cabecalho,
        qtdColunas: linhas[0] ? linhas[0].length : 0,
        amostra: linhas.slice(0, 3),
        // o que existe hoje na coluna que a patrulha lê
        col8: linhas.map((c) => c[8] || '(vazia)'),
        // qualquer coluna que contenha um texto de ação conhecido
        ondeEstaAcao: linhas.slice(0, 5).map((c) =>
          c.findIndex((v) => /ofere[çc]a o full|reative o produto|enviar estoque|envie estoque/i.test(v))),
      };
    });

    console.log('  Cabeçalho da tabela:');
    r.cabecalho.forEach((h, i) => console.log(`    [${i}] ${h || '(sem título)'}`));
    console.log(`\n  Colunas por linha: ${r.qtdColunas}`);

    console.log('\n  Primeiras linhas, coluna por coluna:');
    r.amostra.forEach((c, n) => {
      console.log(`\n    --- linha ${n + 1} ---`);
      c.forEach((v, i) => console.log(`    [${i}]${i === 8 ? ' <-- a patrulha lê esta' : ''} ${v.slice(0, 80)}`));
    });

    const contagem = {};
    r.col8.forEach((v) => { contagem[v] = (contagem[v] || 0) + 1; });
    console.log('\n  O que aparece na coluna 8, em toda a página:');
    Object.entries(contagem).sort((a, b) => b[1] - a[1])
      .forEach(([v, n]) => console.log(`    ${String(n).padStart(4)}x  ${v.slice(0, 70)}`));

    const achou = r.ondeEstaAcao.filter((i) => i >= 0);
    console.log('\n  Onde apareceu texto de ação conhecido nas 5 primeiras linhas:',
      achou.length ? [...new Set(achou)].join(', ') : 'em nenhuma coluna (nenhuma ação pendente nesta página)');
  } finally {
    await navegador.close().catch(() => {});
  }
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
