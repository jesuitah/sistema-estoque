// Teste da Fase 1 — prova que a sessão salva continua funcionando.
//
// Como usar:   npm run testar -- KMP
//
// IMPORTANTE: este script é SÓ LEITURA. Ele não clica em nada, não altera nada,
// não cria nada. O objetivo é único: responder "a sessão emprestada funciona?".
//
// Rode duas vezes, em dias diferentes. Se funcionar nas duas, a sessão dura e a
// base do projeto está provada.

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste, verificarLogin } = require('./navegador');

// Mesma página usada no login como teste de autenticação.
// Medido na prática: deslogado = HTTP 403, logado = HTTP 200.
const URL_ANUNCIOS = 'https://www.mercadolivre.com.br/anuncios/lista';

function agora() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function idadeDaSessao(conta) {
  try {
    const arquivo = path.join(__dirname, 'sessoes', `${conta}.info.json`);
    const info = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const dias = (Date.now() - new Date(info.criada_em).getTime()) / 86400000;
    return { dias: Math.floor(dias), criada_em: info.criada_em, userId: info.userId };
  } catch (_e) {
    return null;
  }
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
  const idade = idadeDaSessao(conta);
  if (idade) {
    console.log(`  Sessão criada há ${idade.dias} dia(s)` + (idade.userId ? ` — user id ${idade.userId}` : ''));
  }
  console.log('  ─────────────────────────────────────────────');
  console.log('');

  const navegador = await abrirNavegador(conta);
  const problemas = [];

  // ── Checagem: a sessão ainda autentica? ─────────────────────────────────────
  // Navegação de verdade até a área do vendedor. Deslogado, o ML redireciona pra
  // tela de login — é esse desvio que denuncia o estado, não o código HTTP
  // (já testado: o status sozinho dá falso positivo, porque a própria tela de
  // login responde 200).
  console.log('  Abrindo a área do vendedor pra ver se a sessão ainda vale...');
  const resultado = await verificarLogin(navegador);

  if (resultado.logado) {
    console.log('     ✅ Autenticado — a área do vendedor abriu normalmente');
    console.log(`        Título: "${resultado.titulo}"`);
  } else if (resultado.indefinido) {
    problemas.push('não deu pra concluir — o Mercado Livre não respondeu direito (bloqueio ou lentidão)');
    console.log('     ⚠  Resposta inconclusiva do ML — não dá pra afirmar nada');
    if (resultado.erro) console.log(`        (${resultado.erro})`);
  } else {
    problemas.push('sessão expirada — o ML mandou pra tela de login');
    console.log('     ❌ Deslogado — fui redirecionado pra tela de login');
    console.log(`        Título: "${resultado.titulo}"`);
  }

  // ── Evidência: print da tela ────────────────────────────────────────────────
  const pagina = navegador.pages()[0] || (await navegador.newPage());
  await pagina.goto(URL_ANUNCIOS, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await pagina.waitForTimeout(3000);
  const arquivoPrint = path.join(__dirname, 'prints', `teste-${conta}-${carimbo()}.png`);
  await pagina.screenshot({ path: arquivoPrint, fullPage: false }).catch(() => {});
  console.log('');
  console.log(`  📸 Print salvo em: robo/prints/${path.basename(arquivoPrint)}`);

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

  await navegador.close().catch(() => {});
  process.exit(problemas.length === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  console.error('');
  process.exit(1);
});
