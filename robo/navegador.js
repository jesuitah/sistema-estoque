// Abertura de navegador compartilhada entre os scripts do robô.
//
// Usamos um PERFIL PERSISTENTE em disco (uma pasta por conta) em vez de só salvar
// cookies num JSON. Motivo: o perfil guarda tudo que um Chrome de verdade guarda
// (cookies, localStorage, IndexedDB, service workers), então a sessão dura muito mais
// e a "impressão digital" do navegador é idêntica em toda execução — igualzinho a
// alguém usando o mesmo computador todo dia, que é exatamente o que queremos parecer.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const CONTAS_VALIDAS = ['KMP', 'ERP', 'LTS'];

function pastaDaSessao(conta) {
  return path.join(__dirname, 'sessoes', conta);
}

function validarConta(conta) {
  if (!conta) {
    throw new Error('Faltou dizer a conta. Ex: npm run login -- KMP');
  }
  const normalizada = String(conta).trim().toUpperCase();
  if (!CONTAS_VALIDAS.includes(normalizada)) {
    throw new Error(`Conta inválida: "${conta}". Use uma de: ${CONTAS_VALIDAS.join(', ')}`);
  }
  return normalizada;
}

function sessaoExiste(conta) {
  const pasta = pastaDaSessao(conta);
  return fs.existsSync(pasta) && fs.readdirSync(pasta).length > 0;
}

// Abre o navegador com o perfil da conta. Sempre visível — nesta fase do projeto o
// Matheus precisa conseguir ver o que está acontecendo.
async function abrirNavegador(conta, opcoes = {}) {
  const pasta = pastaDaSessao(conta);
  fs.mkdirSync(pasta, { recursive: true });

  const config = {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    // Esconde o sinalizador de "navegador controlado por automação" que o Chrome
    // expõe por padrão. Sem isso, qualquer site sabe de cara que é um robô.
    args: ['--disable-blink-features=AutomationControlled'],
    ...opcoes,
  };

  // Preferimos o Chrome de verdade instalado na máquina (mais parecido com uso
  // normal); se não existir, caímos no Chromium que o Playwright baixou.
  try {
    return await chromium.launchPersistentContext(pasta, { ...config, channel: 'chrome' });
  } catch (_e) {
    return await chromium.launchPersistentContext(pasta, config);
  }
}

module.exports = { abrirNavegador, validarConta, sessaoExiste, pastaDaSessao, CONTAS_VALIDAS };
