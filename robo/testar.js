// Teste da Fase 1 — prova que a sessão salva continua funcionando.
//
// Como usar:   npm run testar -- KMP
//
// IMPORTANTE: este script é SÓ LEITURA. Ele não clica em nada, não altera nada,
// não cria nada. O objetivo é único: responder "a sessão emprestada funciona?".
//
// Rode duas vezes, em dias diferentes. Se funcionar nas duas, a sessão dura e a
// base do projeto está provada.

const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste } = require('./navegador');

const URL_MINHA_CONTA = 'https://myaccount.mercadolivre.com.br/';
const URL_ANUNCIOS = 'https://www.mercadolivre.com.br/anuncios/lista';

function agora() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
  const conta = validarConta(process.argv[2]);

  if (!sessaoExiste(conta)) {
    throw new Error(
      `Não existe sessão salva para ${conta}.\n` +
      `     Rode primeiro:  npm run login -- ${conta}`
    );
  }

  console.log('');
  console.log(`  Teste de sessão — conta ${conta}`);
  console.log(`  ${agora()}`);
  console.log('  ─────────────────────────────────────────────');
  console.log('');

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());

  const problemas = [];

  // ── Checagem 1: a sessão ainda é válida? ────────────────────────────────────
  // Perguntamos ao próprio Mercado Livre quem somos, usando os cookies do perfil.
  // Não dependemos de ler a tela, então isso não quebra se o ML mudar o layout.
  console.log('  1) Verificando se a sessão ainda está válida...');
  let identidade = null;
  try {
    const resposta = await pagina.request.get('https://api.mercadolibre.com/users/me');
    if (resposta.ok()) {
      identidade = await resposta.json();
      console.log(`     ✅ Sessão válida — logado como ${identidade.nickname} (id ${identidade.id})`);
    } else {
      problemas.push(`sessão inválida (o ML respondeu ${resposta.status()})`);
      console.log(`     ❌ Sessão expirada ou inválida (HTTP ${resposta.status()})`);
    }
  } catch (erro) {
    problemas.push(`não deu pra verificar a sessão: ${erro.message}`);
    console.log(`     ❌ Falhou: ${erro.message}`);
  }

  // ── Checagem 2: a área de vendedor abre? ────────────────────────────────────
  console.log('');
  console.log('  2) Abrindo a página de anúncios (área do vendedor)...');
  await pagina.goto(URL_ANUNCIOS, { waitUntil: 'domcontentloaded' });
  await pagina.waitForTimeout(3000);

  const urlFinal = pagina.url();
  const caiuNoLogin = /login|registration/i.test(urlFinal);

  if (caiuNoLogin) {
    problemas.push('a área do vendedor pediu login de novo');
    console.log(`     ❌ Fui redirecionado pra tela de login: ${urlFinal}`);
  } else {
    console.log(`     ✅ Abriu sem pedir login`);
    console.log(`        URL: ${urlFinal}`);
    console.log(`        Título: ${await pagina.title()}`);
  }

  // ── Evidência: print da tela ────────────────────────────────────────────────
  const arquivoPrint = path.join(__dirname, 'prints', `teste-${conta}-${carimbo()}.png`);
  await pagina.screenshot({ path: arquivoPrint, fullPage: false });
  console.log('');
  console.log(`  📸 Print salvo em: ${path.relative(process.cwd(), arquivoPrint)}`);

  // ── Veredito ────────────────────────────────────────────────────────────────
  console.log('');
  console.log('  ─────────────────────────────────────────────');
  if (problemas.length === 0) {
    console.log('  ✅ TUDO CERTO — a sessão emprestada está funcionando.');
    console.log('');
    console.log('     Rode este mesmo teste de novo daqui a alguns dias.');
    console.log('     Se passar de novo, a Fase 1 está aprovada.');
  } else {
    console.log('  ❌ DEU PROBLEMA:');
    problemas.forEach((p) => console.log(`     • ${p}`));
    console.log('');
    console.log(`     Provável solução: refazer o login →  npm run login -- ${conta}`);
  }
  console.log('');

  await navegador.close();
  process.exit(problemas.length === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  console.error('');
  process.exit(1);
});
