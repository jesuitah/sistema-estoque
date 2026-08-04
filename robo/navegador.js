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

// ── Verificação de login ─────────────────────────────────────────────────────
//
// Página da área do vendedor usada como teste. Deslogado, o ML redireciona pra
// tela de login; logado, a página abre normalmente.
const URL_TESTE_LOGIN = 'https://www.mercadolivre.com.br/anuncios/lista';

// Reconhece as URLs da tela de login do ML (ela usa o caminho /lgz/).
function ehUrlDeLogin(url) {
  return /\/login|\/lgz\//i.test(String(url || ''));
}

// Descobre, com navegação de verdade, se a sessão está autenticada.
//
// Duas armadilhas que já custaram caro aqui e que este código evita de propósito:
//
// 1. NÃO use `contexto.request.get()` — requisição crua não carrega a impressão
//    digital completa do navegador e o firewall do ML responde de forma
//    inconsistente (ora 403, ora redireciona). Deu falso positivo em teste.
//
// 2. NÃO rode em modo invisível (headless) — o firewall bloqueia e devolve uma
//    página vazia, indistinguível de erro. Só navegador visível responde direito.
//
// Retorna { logado, indefinido, url, titulo }. `indefinido: true` significa
// "não deu pra saber" (bloqueio/timeout) — nesses casos NÃO se conclui nada,
// tenta de novo depois. O robô nunca chuta.
async function verificarLogin(navegador) {
  const aba = await navegador.newPage();
  try {
    await aba.goto(URL_TESTE_LOGIN, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await aba.waitForTimeout(4000);

    const url = aba.url();
    const titulo = await aba.title().catch(() => '');

    if (ehUrlDeLogin(url)) {
      return { logado: false, indefinido: false, url, titulo };
    }
    // Título vazio + sem redirecionamento = página de bloqueio do firewall.
    // Não dá pra concluir nada daí.
    if (!titulo.trim()) {
      return { logado: false, indefinido: true, url, titulo };
    }
    return { logado: true, indefinido: false, url, titulo };
  } catch (erro) {
    return { logado: false, indefinido: true, url: null, titulo: '', erro: erro.message };
  } finally {
    await aba.close().catch(() => {});
  }
}

module.exports = {
  abrirNavegador, validarConta, sessaoExiste, pastaDaSessao, CONTAS_VALIDAS,
  verificarLogin, ehUrlDeLogin, URL_TESTE_LOGIN,
};
