// Encontra os anúncios que o Mercado Livre recomenda "Oferecer Full novamente".
//
// Como usar:   node ler-fora-de-venda.js            (as três contas)
//              node ler-fora-de-venda.js ERP
//
// SOMENTE LEITURA — nenhum clique, nenhuma seleção.
//
// Por que ler a tela em vez da API: a coluna "Ação sugerida" é uma recomendação do
// próprio Mercado Livre e NÃO existe na API oficial. É ela que decide se o robô age.
//
// Não dependemos do filtro "Fora de venda" da tela (nenhum parâmetro de URL aplica
// ele). Lemos todas as linhas e filtramos pela recomendação — mais simples e não
// quebra se mudarem o filtro.

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste, CONTAS_VALIDAS } = require('./navegador');

const BASE = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';
const MAX_PAGINAS = 30;

// A recomendação que nos interessa. As outras ("Retire as unidades...", "Você ainda
// não tem recomendações") o robô ignora, por decisão do Matheus.
const RECOMENDACAO_ALVO = /ofere[çc]a o full novamente/i;

async function esperarTabela(pagina) {
  await pagina
    .waitForFunction(() => /C[óo]digo ML/i.test(document.body.innerText || ''), { timeout: 45000 })
    .catch(() => {});
  await pagina.waitForTimeout(1500);
}

async function lerPagina(pagina, n) {
  await pagina.goto(n === 1 ? BASE : `${BASE}?page=${n}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await esperarTabela(pagina);

  return pagina.evaluate(() => {
    const limpar = (s) => (s || '').trim().replace(/\s+/g, ' ');
    return [...document.querySelectorAll('tr')].slice(1).map((tr) => {
      const c = [...tr.querySelectorAll('td,th')].map((x) => limpar(x.innerText));
      const bruto = c[0] || '';
      const num = (t) => {
        const m = String(t || '').match(/(-?[\d.]+)\s*un\./i);
        return m ? parseInt(m[1].replace(/\./g, ''), 10) : null;
      };
      return {
        codigo_ml: (bruto.match(/C[óo]digo ML:\s*([A-Z0-9]+)/i) || [])[1] || null,
        titulo: limpar(bruto.replace(/.*C[óo]digo ML:\s*[A-Z0-9]+/i, '').replace(/^[\s+\d]*/, '')).slice(0, 70),
        situacao: /pausada/i.test(bruto) ? 'pausada' : (/inativa/i.test(bruto) ? 'inativa' : null),
        aptas_para_venda: num(c[5]),
        acao_sugerida: c[8] || null,
      };
    }).filter((r) => r.codigo_ml);
  });
}

async function lerConta(conta) {
  if (!sessaoExiste(conta)) { console.log(`  ${conta}: sem sessão salva.`); return []; }

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());

  const todos = [];
  const vistos = new Set();
  for (let n = 1; n <= MAX_PAGINAS; n++) {
    const linhas = await lerPagina(pagina, n);
    if (!linhas.length) break;
    if (vistos.has(linhas[0].codigo_ml)) break;   // repetiu a página: acabou
    let novos = 0;
    for (const l of linhas) {
      if (vistos.has(l.codigo_ml)) continue;
      vistos.add(l.codigo_ml);
      todos.push({ ...l, conta });
      novos++;
    }
    process.stdout.write(`    ${conta}: ${todos.length} lidos\r`);
    if (!novos) break;
  }

  await navegador.close().catch(() => {});

  const alvos = todos.filter((t) => RECOMENDACAO_ALVO.test(t.acao_sugerida || ''));
  console.log(`  ${conta}: ${todos.length} produtos no Full · ${alvos.length} com "Ofereça o Full novamente"   `);
  return alvos;
}

async function main() {
  const arg = process.argv[2];
  const contas = arg ? [validarConta(arg)] : CONTAS_VALIDAS;

  console.log('');
  console.log('  Procurando anúncios pra oferecer Full novamente (só leitura)');
  console.log('  ' + '═'.repeat(58));

  let todos = [];
  for (const c of contas) todos = todos.concat(await lerConta(c));

  console.log('');
  if (!todos.length) {
    console.log('  Nenhum anúncio com essa recomendação no momento.');
  } else {
    console.log(`  ${todos.length} anúncio(s) que o robô poderia tratar:`);
    todos.forEach((t) => {
      console.log(`   • ${t.conta} | ${t.codigo_ml} | ${t.aptas_para_venda ?? '?'} un aptas | ${t.situacao || '?'}`);
      console.log(`     ${t.titulo}`);
    });
  }
  fs.writeFileSync(path.join(__dirname, 'prints', 'fora-de-venda.json'), JSON.stringify(todos, null, 2));
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
