// Login manual — roda UMA vez por conta, e depois só quando a sessão expirar.
//
// Como usar:   npm run login -- KMP
//
// O robô NÃO faz login e NÃO vê a senha. Este script só abre um navegador de verdade
// pra VOCÊ logar na mão. Depois que você loga, o perfil fica salvo em disco e os
// outros scripts reusam essa sessão já autenticada.

const readline = require('readline');
const { abrirNavegador, validarConta } = require('./navegador');

const URL_LOGIN = 'https://www.mercadolivre.com.br/hub';
const URL_VERIFICACAO = 'https://myaccount.mercadolivre.com.br/';

function esperarEnter(mensagem) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(mensagem, () => { rl.close(); resolve(); });
  });
}

// Checa de fato se está logado, em vez de supor. A página "minha conta" só abre pra
// quem está autenticado — se não estiver, o ML redireciona pra tela de login.
async function estaLogado(pagina) {
  await pagina.goto(URL_VERIFICACAO, { waitUntil: 'domcontentloaded' });
  await pagina.waitForTimeout(2000);
  const urlFinal = pagina.url();
  const foiRedirecionadoPraLogin = /login|registration|hub\/registration/i.test(urlFinal);
  return { logado: !foiRedirecionadoPraLogin, urlFinal };
}

async function main() {
  const conta = validarConta(process.argv[2]);

  console.log('');
  console.log(`  Abrindo navegador para a conta ${conta}...`);
  console.log('');

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());

  await pagina.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });

  console.log('  ┌─────────────────────────────────────────────────────────────┐');
  console.log(`  │  Faça login na conta ${conta.padEnd(3)} na janela que abriu.            │`);
  console.log('  │                                                             │');
  console.log('  │  Confira que é a conta certa antes de continuar.            │');
  console.log('  │  NÃO feche a janela do navegador.                           │');
  console.log('  └─────────────────────────────────────────────────────────────┘');
  console.log('');

  await esperarEnter('  Quando terminar de logar, aperte ENTER aqui... ');

  console.log('');
  console.log('  Verificando se o login funcionou de verdade...');

  const { logado, urlFinal } = await estaLogado(pagina);

  if (!logado) {
    console.log('');
    console.log('  ❌ NÃO ESTÁ LOGADO.');
    console.log(`     O Mercado Livre redirecionou para: ${urlFinal}`);
    console.log('     Rode de novo e complete o login antes de apertar ENTER.');
    console.log('');
    await navegador.close();
    process.exit(1);
  }

  // Descobre qual conta ficou logada, pra você conferir que é a certa.
  let apelido = null;
  try {
    const resposta = await pagina.request.get('https://api.mercadolibre.com/users/me');
    if (resposta.ok()) {
      const dados = await resposta.json();
      apelido = `${dados.nickname} (id ${dados.id})`;
    }
  } catch (_e) { /* informativo apenas — não impede o sucesso */ }

  console.log('');
  console.log('  ✅ Sessão salva com sucesso.');
  if (apelido) {
    console.log(`     Conta logada: ${apelido}`);
    console.log(`     Você pediu pra salvar como: ${conta}`);
    console.log('     >>> Confira se batem! Se não bateu, rode de novo e logue na conta certa.');
  }
  console.log('');
  console.log('     Próximo passo:  npm run testar -- ' + conta);
  console.log('');

  await navegador.close();
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  console.error('');
  process.exit(1);
});
