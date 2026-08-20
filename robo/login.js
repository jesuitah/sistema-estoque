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
const {
  abrirNavegador, validarConta, ehUrlDeLogin, identificarConta, USER_IDS_ESPERADOS,
} = require('./navegador');

// Mandamos direto pra área do vendedor. Deslogado, o ML desvia pra tela de login e,
// assim que o login termina, ele traz de volta pra ESTA página sozinho. É esse retorno
// que serve de sinal — não precisamos abrir aba nenhuma nem ficar consultando o ML.
const URL_ALVO = 'https://www.mercadolivre.com.br/anuncios/lista';

// MEDIDO NA PRÁTICA: uma vez logado, o Mercado Livre não fica em
// `www.mercadolivre.com.br/anuncios/lista` — ele redireciona pra OUTRO domínio,
// `vendedores.mercadolivre.com.br/anuncios` (a Central de Vendedores).
// Esse domínio só é alcançável autenticado, então chegar nele é a prova do login.
// (Procurar por "/anuncios/lista" foi um bug real: nunca batia, e o login válido
// ficava sem ser detectado.)
const DOMINIO_PAINEL_VENDEDOR = 'vendedores.mercadolivre.com.br';

function ehPainelDoVendedor(url) {
  return String(url || '').indexOf(DOMINIO_PAINEL_VENDEDOR) !== -1;
}

const MINUTOS_DE_ESPERA = 15;
const INTERVALO_MS = 2000;


async function main() {
  const conta = validarConta(process.argv[2]);

  console.log('');
  console.log(`  Abrindo o Chrome para a conta ${conta}...`);

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());

  await pagina.goto(URL_ALVO, { waitUntil: 'domcontentloaded' }).catch(() => {});

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

  // Só OBSERVAMOS a URL da aba do Matheus. Nada de abrir abas nem consultar o ML
  // enquanto ele digita — a versão anterior fazia isso a cada 2 segundos e roubava o
  // foco do teclado, atrapalhando o login (bug real, relatado na prática).
  //
  // Como o navegador foi aberto já apontando pra área do vendedor, o próprio Mercado
  // Livre devolve o Matheus pra essa página quando o login termina. Chegar de volta
  // nela É o sinal de que logou — não precisa de mais nada.
  //
  // Detectar só a página-alvo (e não "qualquer URL que não seja de login") também
  // evita atrapalhar etapas intermediárias do login, como verificação em duas etapas.
  while (Date.now() < limite) {
    // Se a janela foi fechada, para de esperar em vez de travar até o limite.
    if (navegador.pages().length === 0) {
      console.log('');
      console.log('  ⚠  A janela do navegador foi fechada antes de concluir o login.');
      console.log(`     Rode de novo:  npm run login -- ${conta}`);
      console.log('');
      process.exit(1);
    }

    // Olha todas as abas: o ML às vezes conclui o login numa aba nova.
    for (const aba of navegador.pages()) {
      const url = aba.url();
      if (ehUrlDeLogin(url)) continue;
      if (!ehPainelDoVendedor(url)) continue;

      // Voltou pra página do vendedor. Confere que ela carregou de verdade
      // (título vazio = página de bloqueio, não conclui nada).
      const titulo = await aba.title().catch(() => '');
      if (titulo.trim()) {
        logado = true;
        break;
      }
    }
    if (logado) break;

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

  // TRAVA DE SEGURANÇA: confere se a conta que logou é MESMO a que foi pedida.
  // Sem isso, logar na conta errada passa despercebido e o robô acaba agindo na loja
  // errada depois — erro que já aconteceu neste projeto.
  const identidade = await identificarConta(navegador);
  const esperado = USER_IDS_ESPERADOS[conta];

  if (identidade.userId && identidade.userId !== esperado) {
    const contaReal = Object.keys(USER_IDS_ESPERADOS)
      .find((k) => USER_IDS_ESPERADOS[k] === identidade.userId) || 'desconhecida';
    console.log('');
    console.log('  ⛔ CONTA ERRADA — sessão NÃO foi aceita.');
    console.log('');
    console.log(`     Você pediu pra salvar como : ${conta}  (id ${esperado})`);
    console.log(`     Mas quem logou foi         : ${identidade.apelido || '?'}  (id ${identidade.userId} = ${contaReal})`);
    console.log('');
    console.log('     Saia dessa conta no navegador e rode de novo logando na conta certa.');
    console.log('');
    await navegador.close().catch(() => {});
    process.exit(1);
  }

  console.log('');
  console.log('  ✅ Login detectado! Sessão salva.');
  console.log('');
  console.log(`     Conta : ${identidade.apelido || '(apelido não identificado)'}`);
  console.log(`     Id    : ${identidade.userId || '?'}`);
  if (identidade.userId === esperado) {
    console.log(`     ✅ Confere com a ${conta} — conta certa.`);
  } else {
    console.log(`     ⚠  Não deu pra confirmar o id. Confira na janela se é a ${conta}.`);
  }
  console.log('');
  console.log(`     Próximo passo:  npm run testar -- ${conta}`);
  console.log('');
  const pistas = { userId: identidade.userId, apelido: identidade.apelido };

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
