// Exploração SOMENTE LEITURA da Central de Vendedores.
//
// Como usar:   npm run explorar -- KMP
//
// REGRA DESTE SCRIPT: ele navega e lê. Não clica em botão de ação, não salva nada,
// não altera nada em nenhuma loja. Serve pra mapear o que existe antes de construir
// qualquer automação — pra depois agir com base em fato, não em suposição.

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste, identificarConta } = require('./navegador');

const PAINEL = 'https://vendedores.mercadolivre.com.br/anuncios';

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function print(pagina, nome) {
  const arquivo = path.join(__dirname, 'prints', `${nome}-${carimbo()}.png`);
  await pagina.screenshot({ path: arquivo, fullPage: false }).catch(() => {});
  return path.basename(arquivo);
}

async function main() {
  const conta = validarConta(process.argv[2]);
  if (!sessaoExiste(conta)) throw new Error(`Sem sessão salva para ${conta}. Rode: npm run login -- ${conta}`);

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());

  const identidade = await identificarConta(navegador);
  console.log('');
  console.log(`  Explorando ${conta} — ${identidade.apelido || '?'} (id ${identidade.userId || '?'})`);
  console.log('  ─────────────────────────────────────────────────────────');

  await pagina.goto(PAINEL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pagina.waitForTimeout(6000);

  console.log(`  URL   : ${pagina.url()}`);
  console.log(`  Título: "${await pagina.title()}"`);

  // Abas / seções disponíveis no painel (lidas da própria página, sem adivinhar URL)
  const abas = await pagina.evaluate(() => {
    const vistos = new Set();
    const saida = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const texto = (a.innerText || '').trim().replace(/\s+/g, ' ');
      const href = a.href;
      if (!texto || texto.length > 60) return;
      if (!/mercadolivre|mercadolibre/.test(href)) return;
      const chave = texto + '|' + href;
      if (vistos.has(chave)) return;
      vistos.add(chave);
      saida.push({ texto, href });
    });
    return saida;
  });

  const interessantes = abas.filter((a) =>
    /full|promo|pre[çc]o|estoque|an[úu]ncio|qualidade|m[ée]trica|campanha/i.test(a.texto)
  );

  console.log('');
  console.log(`  Links relevantes encontrados (${interessantes.length}):`);
  interessantes.slice(0, 30).forEach((a) => {
    console.log(`   • ${a.texto}`);
    console.log(`     ${a.href}`);
  });

  // Cartões de resumo no topo (ex: "Sem estoque 5", "Com objetivos de qualidade 316")
  const resumos = await pagina.evaluate(() => {
    const out = [];
    document.querySelectorAll('div,section,article').forEach((el) => {
      if (el.children.length > 6) return;
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 120) return;
      if (/^(sem estoque|com objetivos|economia|full|estoque)/i.test(t)) out.push(t);
    });
    return [...new Set(out)].slice(0, 15);
  });

  if (resumos.length) {
    console.log('');
    console.log('  Cartões de resumo na tela:');
    resumos.forEach((r) => console.log(`   • ${r}`));
  }

  const arquivoPrint = await print(pagina, `explorar-${conta}-painel`);
  console.log('');
  console.log(`  📸 ${arquivoPrint}`);

  // Guarda o mapa em arquivo pra consultar depois sem reabrir navegador
  fs.writeFileSync(
    path.join(__dirname, 'prints', `mapa-${conta}.json`),
    JSON.stringify({ conta, identidade, url: pagina.url(), abas, resumos }, null, 2)
  );

  await navegador.close().catch(() => {});
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  console.error('');
  process.exit(1);
});
