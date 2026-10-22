// TESTADOR DE TELAS — a conferida que eu fazia na mão, agora sempre igual.
//
// POR QUE EXISTE (21/10/2026)
//
// O validar-index.js confere parênteses e nomes soltos. Isso pega erro de digitação,
// mas não pegou nenhum dos três tropeços que custaram tempo ao Matheus em outubro:
//
//   · publiquei a Edge Function de promoções com um arquivo vazio dentro
//   · entreguei uma lista com 234 anúncios errados
//   · fiz seis alterações e não enviei pro GitHub — ele passou um dia vendo a versão velha
//
// Nenhum é erro de código. Todos são erro de CONFERÊNCIA: eu abria a página, olhava a
// parte que tinha mexido e dava por bom. Este arquivo tira isso da minha disposição e
// transforma num comando: ou passa, ou não publico.
//
// COMO USAR
//   node robo/testar-telas.js           confere tudo
//   node robo/testar-telas.js --rapido  pula a comparação com o que está publicado
//
// O QUE ELE FAZ
//   1. sobe o site numa porta local e abre num Chrome de verdade
//   2. entra pelo perfil Visualização (o único que não pede senha)
//   3. passa por TODAS as abas, uma a uma
//   4. em cada uma: olha se renderizou, se o console não cuspiu erro e se o banco
//      respondeu sem 4xx/5xx
//   5. compara o arquivo daqui com o que está no ar e avisa se há commit não enviado
//
// O Matheus também pode rodar quando quiser saber se está tudo de pé — depois de uma
// queda, ou numa segunda de manhã — sem precisar clicar em nada.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const RAIZ = path.join(__dirname, '..');
const NO_AR = 'https://jesuitah.github.io/sistema-estoque/index.html';

// Normalmente testa o index.html de verdade. A variável PAGINA_TESTE serve pra apontar
// pra uma cópia quebrada de propósito e conferir que o testador REPROVA quando deve —
// um testador que só sabe dizer "passou" não serve pra nada.
const PAGINA = process.env.PAGINA_TESTE || 'index.html';

// Os rótulos são os mesmos que aparecem na tela. Se alguém renomear uma aba, o teste
// reclama que não achou — e isso é bom: quero saber que a navegação mudou.
const ABAS = [
  '🤖 Robô', '📦 Pedidos ML', '> Busca', '💰 Preços',
  '📢 Anúncios', '🏷 Promoções', '❓ Perguntas', '✅ Tarefas',
];

// Barulho conhecido que não é problema do sistema.
const RUIDO = [
  /favicon/i,
  /Download the React DevTools/i,
  /cdn\.tailwindcss\.com should not be used in production/i,
  /\[Violation\]/i,
];
const ehRuido = (t) => RUIDO.some((r) => r.test(t));

const TIPOS = { css: 'text/css', js: 'application/javascript', html: 'text/html; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', json: 'application/json',
  webmanifest: 'application/manifest+json' };

// Servidor só pra este teste: serve a pasta do projeto numa porta livre.
function subirServidor() {
  return new Promise((resolve) => {
    const servidor = http.createServer((req, res) => {
      const limpo = decodeURIComponent(req.url.split('?')[0]);
      const alvo = path.join(RAIZ, limpo === '/' ? 'index.html' : limpo);
      if (!alvo.startsWith(RAIZ) || !fs.existsSync(alvo) || fs.statSync(alvo).isDirectory()) {
        res.writeHead(404); return res.end('nao encontrado');
      }
      res.writeHead(200, { 'Content-Type': TIPOS[alvo.split('.').pop()] || 'text/plain' });
      fs.createReadStream(alvo).pipe(res);
    });
    servidor.listen(0, '127.0.0.1', () => resolve({ servidor, porta: servidor.address().port }));
  });
}

const hash = (t) => crypto.createHash('sha256').update(t.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);

// O que está no ar é o que eu tenho aqui? Foi o erro de 16/10: seis commits parados
// na máquina e ele olhando a versão de ontem sem saber.
async function conferirPublicado() {
  const local = hash(fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8'));
  let naoEnviados = 0;
  try {
    const saida = execSync('git log origin/main..HEAD --oneline', { cwd: RAIZ }).toString().trim();
    naoEnviados = saida ? saida.split('\n').length : 0;
  } catch (_e) { /* sem git ou sem remoto: segue */ }

  let publicado = null;
  try {
    const r = await fetch(NO_AR, { cache: 'no-store' });
    if (r.ok) publicado = hash(await r.text());
  } catch (_e) { /* sem internet: reporta como desconhecido */ }

  return { local, publicado, igual: publicado ? publicado === local : null, naoEnviados };
}

async function testar({ rapido = false } = {}) {
  const inicio = Date.now();
  const { servidor, porta } = await subirServidor();
  const navegador = await chromium.launch({ headless: true });
  const pagina = await navegador.newPage();

  const problemas = [];   // o que reprova
  const avisos = [];      // o que é bom saber
  let abaAtual = 'carregando o site';

  pagina.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (ehRuido(t)) return;
    problemas.push({ aba: abaAtual, o_que: 'erro no console', detalhe: t.slice(0, 160) });
  });
  pagina.on('pageerror', (e) => {
    problemas.push({ aba: abaAtual, o_que: 'a tela quebrou', detalhe: String(e.message).slice(0, 160) });
  });
  pagina.on('response', (r) => {
    if (r.status() < 400) return;
    const url = r.url();
    if (!/supabase\.co/.test(url)) return;
    const tabela = (url.match(/rest\/v1\/([a-z_]+)/) || url.match(/functions\/v1\/([a-z-]+)/) || [])[1] || url.slice(0, 60);
    problemas.push({ aba: abaAtual, o_que: `o banco recusou (HTTP ${r.status()})`, detalhe: tabela });
  });

  const resultadoAbas = [];
  try {
    await pagina.goto(`http://127.0.0.1:${porta}/${PAGINA}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Entra pelo perfil Visualização: é o único sem senha, e é só leitura — o teste
    // nunca grava nada no banco de verdade.
    await pagina.getByRole('button', { name: /Visualiza/ }).click({ timeout: 20000 });
    await pagina.waitForTimeout(5000);
    abaAtual = 'entrada';

    for (const nome of ABAS) {
      abaAtual = nome;
      const antes = problemas.length;
      const botao = pagina.getByRole('button', { name: nome, exact: false }).first();
      if (!(await botao.count())) {
        problemas.push({ aba: nome, o_que: 'não achei a aba', detalhe: 'o botão sumiu ou foi renomeado' });
        resultadoAbas.push({ nome, ok: false, texto: 0 });
        continue;
      }
      await botao.click();
      await pagina.waitForTimeout(4500);

      // Renderizou alguma coisa? Tela em branco é o sintoma clássico de JS quebrado.
      const texto = (await pagina.locator('main').innerText().catch(() => '')) || '';
      if (texto.trim().length < 40) {
        problemas.push({ aba: nome, o_que: 'tela vazia', detalhe: `só ${texto.trim().length} caracteres` });
      }
      if (/undefined|NaN|\[object Object\]/.test(texto)) {
        const achado = (texto.match(/.{0,30}(undefined|NaN|\[object Object\]).{0,30}/) || [])[0] || '';
        avisos.push({ aba: nome, o_que: 'apareceu dado cru na tela', detalhe: achado.trim() });
      }
      resultadoAbas.push({ nome, ok: problemas.length === antes, texto: texto.trim().length });
    }
  } catch (erro) {
    problemas.push({ aba: abaAtual, o_que: 'o teste parou no meio', detalhe: String(erro.message).slice(0, 200) });
  } finally {
    await navegador.close().catch(() => {});
    servidor.close();
  }

  const publicado = rapido ? null : await conferirPublicado();
  return { problemas, avisos, abas: resultadoAbas, publicado, segundos: Math.round((Date.now() - inicio) / 1000) };
}

function imprimir(r) {
  const L = console.log;
  L('');
  L('  Testador de telas — ' + r.segundos + 's');
  L('  ' + '═'.repeat(58));

  for (const a of r.abas) {
    L(`  ${a.ok ? '✓' : '✗'} ${a.nome.padEnd(16)} ${a.texto} caracteres na tela`);
  }

  if (r.publicado) {
    L('');
    const p = r.publicado;
    if (p.igual === null) L('  ? não consegui ler o site publicado (sem internet?)');
    else if (p.igual) L('  ✓ o que está no ar é igual ao arquivo daqui');
    else L('  ✗ O QUE ESTÁ NO AR É DIFERENTE do arquivo daqui');
    if (p.naoEnviados > 0) L(`  ✗ ${p.naoEnviados} commit(s) ainda não enviados pro GitHub`);
  }

  if (r.avisos.length) {
    L('');
    L('  Avisos (não reprovam):');
    for (const a of r.avisos) L(`    · ${a.aba}: ${a.o_que} — ${a.detalhe}`);
  }

  L('');
  if (!r.problemas.length) {
    L('  ✅ PODE PUBLICAR');
  } else {
    L(`  ⛔ NÃO PUBLIQUE — ${r.problemas.length} problema(s):`);
    for (const p of r.problemas) L(`    · ${p.aba}: ${p.o_que} — ${p.detalhe}`);
  }
  L('');
}

module.exports = { testar };

if (require.main === module) {
  testar({ rapido: process.argv.includes('--rapido') }).then(
    (r) => {
      imprimir(r);
      // Sai pelo código de saída, não por process.exit(): matar o processo com o
      // navegador e o servidor ainda fechando fazia o Node do Windows cuspir
      // "Assertion failed ... uv_handle_closing" no fim de um teste bem-sucedido.
      process.exitCode = r.problemas.length ? 1 : 0;
    },
    (e) => { console.error('  o testador falhou:', e.message); process.exitCode = 1; },
  );
}
