// DIAGNÓSTICO — só leitura. NÃO CLICA EM NADA.
//
// Onde foi parar o identificador que a reativação precisa?
// O robô procurava um MLBU... dentro dos links da linha e não acha mais.
// Aqui despejamos tudo que a linha carrega — links, atributos, checkbox — pra
// descobrir por qual chave o anúncio é identificado hoje.
//
// Como usar:  node conferir-linha.js KMP

const { abrirNavegador } = require('./navegador');

const PAINEL = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';
const ACAO = /ofere[çc]a o full novamente|reative o produto/i;

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  console.log(`\n  ${conta} — dissecando a linha de quem precisa de conserto\n`);

  const navegador = await abrirNavegador(conta);
  try {
    const pagina = navegador.pages()[0] || (await navegador.newPage());
    await pagina.goto(PAINEL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pagina.waitForFunction(() => /C[óo]digo ML/i.test(document.body.innerText || ''), { timeout: 45000 }).catch(() => {});
    await pagina.waitForTimeout(2500);

    const r = await pagina.evaluate((fonte) => {
      const re = new RegExp(fonte, 'i');
      const limpar = (s) => (s || '').trim().replace(/\s+/g, ' ');
      const alvo = [...document.querySelectorAll('tr')].find((tr) => {
        const c = [...tr.querySelectorAll('td,th')].map((x) => limpar(x.innerText));
        return c[0] && /C[óo]digo ML/i.test(c[0]) && re.test(c[8] || '');
      });
      if (!alvo) return { achou: false };

      const atributos = [];
      alvo.querySelectorAll('*').forEach((el) => {
        [...el.attributes].forEach((a) => {
          if (/^(class|style)$/.test(a.name)) return;
          if (!a.value) return;
          atributos.push(`${el.tagName.toLowerCase()}[${a.name}] = ${a.value.slice(0, 120)}`);
        });
      });

      return {
        achou: true,
        texto: limpar(alvo.innerText).slice(0, 120),
        links: [...alvo.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
        atributos: [...new Set(atributos)],
        // procura qualquer coisa parecida com id do ML no HTML da linha
        idsNoHtml: [...new Set((alvo.outerHTML.match(/ML[A-Z]?U?\d{6,}/g) || []))],
        tamanhoHtml: alvo.outerHTML.length,
      };
    }, ACAO.source);

    if (!r.achou) { console.log('  Nenhuma linha precisando de conserto nesta página agora.'); return; }

    console.log('  Linha:', r.texto, '\n');
    console.log('  Links da linha:');
    (r.links.length ? r.links : ['(nenhum)']).forEach((l) => console.log('    ' + String(l).slice(0, 130)));
    console.log('\n  Ids parecidos com ML encontrados no HTML da linha:');
    console.log('    ' + (r.idsNoHtml.length ? r.idsNoHtml.join(', ') : '(NENHUM)'));
    console.log('\n  Atributos da linha (sem class/style):');
    r.atributos.slice(0, 40).forEach((a) => console.log('    ' + a));
    console.log(`\n  (HTML da linha tem ${r.tamanhoHtml} caracteres)`);
  } finally {
    await navegador.close().catch(() => {});
  }
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
