// Gravador de operação manual.
//
// Como usar:   node gravar.js KMP
//
// O QUE ELE FAZ: abre o navegador com a sessão salva e fica ESCUTANDO as chamadas
// de rede que o Mercado Livre dispara. Quem opera é o Matheus, na mão — o script
// não clica em nada, só anota o que aconteceu por baixo.
//
// PARA QUE SERVE: descobrir qual chamada o painel faz quando você reativa um anúncio
// do Full. Sabendo isso, o robô pode fazer a MESMA chamada diretamente, em vez de
// imitar cliques na tela. É mais robusto: não quebra quando o layout muda.
//
// Ao fechar o navegador, salva tudo em robo/prints/gravacao-<CONTA>-<hora>.json

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste } = require('./navegador');

// Só interessam chamadas que MUDAM alguma coisa; GET de leitura é ruído.
const METODOS_INTERESSANTES = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Ruído conhecido: rastreamento, métricas, telemetria.
const RUIDO = /google|facebook|hotjar|newrelic|datadog|analytics|metrics|beacon|melidata|track|gtm|doubleclick|clarity/i;

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
  const conta = validarConta(process.argv[2] || 'KMP');
  if (!sessaoExiste(conta)) throw new Error(`Sem sessão salva para ${conta}.`);

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());

  const capturadas = [];

  navegador.on('request', (req) => {
    try {
      const metodo = req.method();
      const url = req.url();
      if (!METODOS_INTERESSANTES.includes(metodo)) return;
      if (RUIDO.test(url)) return;

      let corpo = null;
      try { corpo = req.postData(); } catch (_e) { /* alguns não expõem */ }

      capturadas.push({
        quando: new Date().toISOString(),
        metodo,
        url,
        corpo: corpo ? String(corpo).slice(0, 4000) : null,
        cabecalhos: req.headers(),
      });

      console.log(`  ➜ ${metodo} ${url.slice(0, 110)}`);
      if (corpo) console.log(`      corpo: ${String(corpo).slice(0, 200)}`);
    } catch (_e) { /* nunca deixar o gravador derrubar a sessão */ }
  });

  // registra também o que voltou, pra sabermos se deu certo
  navegador.on('response', async (resp) => {
    try {
      const req = resp.request();
      if (!METODOS_INTERESSANTES.includes(req.method())) return;
      if (RUIDO.test(req.url())) return;
      const alvo = capturadas.find((c) => c.url === req.url() && !c.status);
      if (alvo) {
        alvo.status = resp.status();
        let texto = null;
        try { texto = (await resp.text()).slice(0, 1500); } catch (_e) { /* binário ou já consumido */ }
        alvo.resposta = texto;
        console.log(`      ← ${resp.status()}`);
      }
    } catch (_e) { /* idem */ }
  });

  await pagina.goto('https://vendedores.mercadolivre.com.br/anuncios/lista/space_management', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  }).catch(() => {});

  console.log('');
  console.log('  ┌────────────────────────────────────────────────────────────────┐');
  console.log(`  │  GRAVANDO — conta ${conta}                                            │`);
  console.log('  │                                                                │');
  console.log('  │  Faça UMA vez, na mão, a operação que você quer automatizar.   │');
  console.log('  │  Eu não clico em nada: só anoto o que o Mercado Livre faz.     │');
  console.log('  │                                                                │');
  console.log('  │  Quando terminar, FECHE a janela do navegador.                 │');
  console.log('  └────────────────────────────────────────────────────────────────┘');
  console.log('');

  // espera o Matheus fechar o navegador
  await new Promise((resolve) => {
    navegador.on('close', resolve);
    const timer = setInterval(() => {
      if (navegador.pages().length === 0) { clearInterval(timer); resolve(); }
    }, 1000);
  });

  const arquivo = path.join(__dirname, 'prints', `gravacao-${conta}-${carimbo()}.json`);
  fs.writeFileSync(arquivo, JSON.stringify(capturadas, null, 2));

  console.log('');
  console.log(`  ✅ ${capturadas.length} chamadas gravadas.`);
  console.log(`     ${arquivo}`);
  console.log('');
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  process.exit(1);
});
