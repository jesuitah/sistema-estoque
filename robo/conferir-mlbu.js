// DIAGNÓSTICO — só leitura. NÃO CLICA EM NADA.
//
// Testa a hipótese: o robô procura o user_product_id (MLBU...) na página errada.
// A leitura da lista termina na ÚLTIMA página; a busca do MLBU roda logo depois,
// olhando a tela que estiver carregada. Se o anúncio a consertar estiver na
// página 1, ele não está mais no DOM — e o robô o descarta em silêncio.
//
// Como usar:  node conferir-mlbu.js KMP

const { abrirNavegador } = require('./navegador');

const PAINEL = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';
const ACAO = /ofere[çc]a o full novamente|reative o produto/i;

async function abrirPagina(pagina, n) {
  await pagina.goto(n === 1 ? PAINEL : `${PAINEL}?page=${n}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pagina.waitForFunction(() => /C[óo]digo ML/i.test(document.body.innerText || ''), { timeout: 45000 }).catch(() => {});
  await pagina.waitForTimeout(1500);
}

// Lê a página atual: quem precisa de ação e se o MLBU está ali na linha
async function lerPaginaAtual(pagina) {
  return pagina.evaluate((fonteRegex) => {
    const re = new RegExp(fonteRegex, 'i');
    const limpar = (s) => (s || '').trim().replace(/\s+/g, ' ');
    const saida = [];
    [...document.querySelectorAll('tr')].forEach((tr) => {
      const c = [...tr.querySelectorAll('td,th')].map((x) => limpar(x.innerText));
      const cod = (c[0] || '').match(/C[óo]digo ML:\s*([A-Z0-9]+)/i);
      if (!cod) return;
      if (!re.test(c[8] || '')) return;
      const hrefs = [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '').join(' ');
      const up = hrefs.match(/(MLBU\d+)/);
      saida.push({ codigo: cod[1], acao: (c[8] || '').slice(0, 45), mlbu: up ? up[1] : null });
    });
    return saida;
  }, ACAO.source);
}

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  console.log(`\n  ${conta} — procurando quem precisa de conserto, página por página\n`);

  const navegador = await abrirNavegador(conta);
  try {
    const pagina = navegador.pages()[0] || (await navegador.newPage());
    const achados = [];
    let ultimaPagina = 0;

    for (let n = 1; n <= 30; n++) {
      await abrirPagina(pagina, n);
      const temLinhas = await pagina.evaluate(() =>
        [...document.querySelectorAll('tr')].some((tr) => /C[óo]digo ML/i.test(tr.innerText || '')));
      if (!temLinhas) break;
      ultimaPagina = n;
      const r = await lerPaginaAtual(pagina);
      r.forEach((x) => achados.push({ ...x, pagina: n }));
      if (r.length) r.forEach((x) => console.log(`    pág ${n}: ${x.codigo}  MLBU=${x.mlbu || 'NÃO ACHOU'}  (${x.acao})`));
    }

    console.log(`\n  Total de páginas: ${ultimaPagina}`);
    console.log(`  Anúncios precisando de conserto: ${achados.length}`);
    console.log(`  Deles, com MLBU legível na própria linha: ${achados.filter((a) => a.mlbu).length}`);

    // Agora o teste da hipótese: parado na última página, o robô acha os MLBU?
    console.log(`\n  Simulando o que o robô faz hoje (ficar na última página e só então procurar):`);
    await abrirPagina(pagina, ultimaPagina);
    const codigos = achados.map((a) => a.codigo);
    const mapa = await pagina.evaluate((alvos) => {
      const mapa = {};
      [...document.querySelectorAll('tr')].forEach((tr) => {
        const m = (tr.innerText || '').match(/C[óo]digo ML:\s*([A-Z0-9]+)/i);
        if (!m || alvos.indexOf(m[1]) === -1) return;
        const link = [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '').join(' ');
        const up = link.match(/(MLBU\d+)/);
        if (up) mapa[m[1]] = up[1];
      });
      return mapa;
    }, codigos);

    console.log(`    encontrou ${Object.keys(mapa).length} de ${codigos.length}`);
    if (codigos.length && !Object.keys(mapa).length) {
      console.log(`\n  >>> CONFIRMADO: parado na última página, o robô não acha nenhum.`);
      console.log(`  >>> É por isso que ele nunca reativou nada.`);
    }
  } finally {
    await navegador.close().catch(() => {});
  }
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
