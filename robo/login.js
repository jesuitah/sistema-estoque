// Login manual — roda UMA vez por conta, e depois só quando a sessão expirar.
//
// Como usar:   npm run login -- KMP
//
// O robô NÃO faz login e NÃO vê a senha. Este script só abre um navegador de verdade
// pra VOCÊ logar na mão. Depois que você loga, o perfil fica salvo em disco e os
// outros scripts reusam essa sessão já autenticada.
//
// O script detecta SOZINHO quando o login foi concluído — não precisa apertar nada
// no terminal, é só logar na janela do navegador que abriu.

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, verificarLogin, ehUrlDeLogin } = require('./navegador');

const URL_INICIAL = 'https://www.mercadolivre.com.br/hub';

const MINUTOS_DE_ESPERA = 15;
const INTERVALO_MS = 2000;

// Depois de logado, tenta descobrir QUAL conta é, pra você conferir que é a certa.
// Best-effort: se não conseguir, não impede o sucesso (você confere na tela).
async function descobrirConta(navegador) {
  const pistas = {};
  try {
    const cookies = await navegador.cookies();
    for (const c of cookies) {
      // Cookies do ML que costumam carregar o id do vendedor.
      if (/^(orguseridp|user_id|userid)$/i.test(c.name) && /^\d{6,}$/.test(String(c.value))) {
        pistas.userId = c.value;
      }
    }
  } catch (_e) { /* informativo apenas */ }
  return pistas;
}

async function main() {
  const conta = validarConta(process.argv[2]);

  console.log('');
  console.log(`  Abrindo o Chrome para a conta ${conta}...`);

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());

  await pagina.goto(URL_INICIAL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('');
  console.log('  ┌───────────────────────────────────────────────────────────────┐');
  console.log(`  │  Faça login na conta ${conta} na janela do Chrome que abriu.       │`);
  console.log('  │                                                               │');
  console.log('  │  Não precisa apertar nada aqui — eu detecto sozinho quando    │');
  console.log('  │  você terminar. Só não feche a janela do navegador.           │');
  console.log('  └───────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Aguardando o login (até ${MINUTOS_DE_ESPERA} minutos)...`);

  const limite = Date.now() + MINUTOS_DE_ESPERA * 60 * 1000;
  let logado = false;
  let ciclos = 0;

  // Estratégia em dois estágios, pra não ficar martelando o Mercado Livre:
  //
  //  1. Observar a URL da aba onde o Matheus está logando. Isso é de graça — não
  //     gera nenhuma requisição — e enquanto ele estiver na tela de login, a URL
  //     continua com a cara de login.
  //  2. Quando ele SAIR da tela de login, aí sim fazer UMA verificação de verdade
  //     pra confirmar. Se não confirmar, volta a observar.
  //
  // Assim o número de requisições é mínimo: uma por tentativa real de login.
  while (Date.now() < limite) {
    // Se a janela foi fechada, para de esperar em vez de travar até o limite.
    if (navegador.pages().length === 0) {
      console.log('');
      console.log('  ⚠  A janela do navegador foi fechada antes de concluir o login.');
      console.log(`     Rode de novo:  npm run login -- ${conta}`);
      console.log('');
      process.exit(1);
    }

    const urlAtual = pagina.url();
    const aindaNaTelaDeLogin = ehUrlDeLogin(urlAtual);

    if (!aindaNaTelaDeLogin) {
      const resultado = await verificarLogin(navegador);
      if (resultado.logado) {
        logado = true;
        break;
      }
      if (resultado.indefinido) {
        // Bloqueio momentâneo ou timeout — não concluímos nada, só tentamos depois.
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
    }

    ciclos++;
    if (ciclos % 30 === 0) {
      const faltam = Math.ceil((limite - Date.now()) / 60000);
      console.log(`     ...ainda esperando (faltam ~${faltam} min)`);
    }

    await new Promise((r) => setTimeout(r, INTERVALO_MS));
  }

  if (!logado) {
    console.log('');
    console.log(`  ❌ Passaram ${MINUTOS_DE_ESPERA} minutos e o login não foi concluído.`);
    console.log(`     Rode de novo quando estiver com a senha em mãos:`);
    console.log(`     npm run login -- ${conta}`);
    console.log('');
    await navegador.close().catch(() => {});
    process.exit(1);
  }

  const pistas = await descobrirConta(navegador);

  console.log('');
  console.log('  ✅ Login detectado! Sessão salva.');
  console.log('');
  console.log(`     Salvo como: ${conta}`);
  if (pistas.userId) {
    console.log(`     User id do Mercado Livre: ${pistas.userId}`);
    console.log('     >>> CONFIRA se esse id bate com a conta que você queria.');
  } else {
    console.log('     >>> CONFIRA na janela do navegador se é a conta certa antes de seguir.');
  }
  console.log('');
  console.log(`     Próximo passo:  npm run testar -- ${conta}`);
  console.log('');

  // Registro simples de quando a sessão foi criada — útil pra saber quanto ela dura.
  try {
    fs.writeFileSync(
      path.join(__dirname, 'sessoes', `${conta}.info.json`),
      JSON.stringify({ conta, criada_em: new Date().toISOString(), ...pistas }, null, 2)
    );
  } catch (_e) { /* não é crítico */ }

  // Dá um instante pro perfil terminar de gravar em disco antes de fechar.
  await new Promise((r) => setTimeout(r, 2000));
  await navegador.close().catch(() => {});
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  console.error('');
  process.exit(1);
});
