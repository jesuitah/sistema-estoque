// Confere se o script do index.html continua sintaticamente inteiro.
//
// O arquivo é um React sem build, dentro de <script type="text/babel"> — não há
// compilador para acusar erro antes de publicar. Depois de remover abas inteiras na
// unha, um parêntese sobrando derruba a página em branco e só se descobre no navegador.
//
// Como usar:  node validar.js ../caminho/index.html

const fs = require('fs');

const arquivo = process.argv[2] || 'index.html';
const html = fs.readFileSync(arquivo, 'utf8');

// O app é o último <script> sem src do arquivo.
const blocos = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const m = blocos.length ? blocos[blocos.length - 1] : null;
if (!m) { console.error('não achei o bloco <script> do app'); process.exit(2); }
const src = m[1];

let par = 0, chav = 0, colch = 0;
let str = null, escapa = false, comLinha = false, comBloco = false;

for (let i = 0; i < src.length; i++) {
  const c = src[i], prox = src[i + 1];

  if (comLinha) { if (c === '\n') comLinha = false; continue; }
  if (comBloco) { if (c === '*' && prox === '/') { comBloco = false; i++; } continue; }
  if (str) {
    if (escapa) { escapa = false; continue; }
    if (c === '\\') { escapa = true; continue; }
    if (c === str) str = null;
    continue;
  }
  if (c === '/' && prox === '/') { comLinha = true; i++; continue; }
  if (c === '/' && prox === '*') { comBloco = true; i++; continue; }
  if (c === '"' || c === "'" || c === '`') { str = c; continue; }

  if (c === '(') par++; else if (c === ')') par--;
  else if (c === '{') chav++; else if (c === '}') chav--;
  else if (c === '[') colch++; else if (c === ']') colch--;
}

console.log(`  parênteses ${par} · chaves ${chav} · colchetes ${colch}`);
if (par || chav || colch) { console.error('  ❌ DESBALANCEADO — não publique'); process.exit(1); }
console.log('  ✅ balanceado');
