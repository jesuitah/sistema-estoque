// Confere se o script do index.html continua inteiro ANTES de publicar.
//
// O arquivo é um React sem build, dentro de <script type="text/babel"> — não há
// compilador para acusar erro. Um deslize derruba a página inteira em branco, e só
// se descobre no navegador, depois de publicado.
//
// São DUAS conferências:
//
//   1. PARÊNTESES — o clássico: remover uma aba na unha e deixar um ) sobrando.
//
//   2. NOMES QUE NÃO EXISTEM — o que aconteceu em 04/09/2026: ao apagar um bloco,
//      a variável `manuaisTravados` continuou sendo usada 4 vezes e não era mais
//      declarada em lugar nenhum. Os parênteses fechavam certinho, o validador deu
//      ✅, e a aba "Reativar fora de venda" abria em branco. Balanço de parênteses
//      não pega isso — só olhar os nomes pega.
//
// Como usar:  node validar-index.js [caminho/index.html]

const fs = require('fs');
const path = require('path');

const arquivo = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(arquivo, 'utf8');

// O app é o último <script> sem src do arquivo.
const blocos = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const m = blocos.length ? blocos[blocos.length - 1] : null;
if (!m) { console.error('não achei o bloco <script> do app'); process.exit(2); }
const src = m[1];

// ── 1. Balanço de parênteses ────────────────────────────────────────────────
//
// De quebra, esta varredura devolve o código LIMPO — sem textos entre aspas e sem
// comentários. É esse texto limpo que a conferência de nomes usa; senão, uma palavra
// dentro de uma frase em português viraria "variável não declarada".

let par = 0, chav = 0, colch = 0;
let limpo = '';
let str = null, escapa = false, comLinha = false, comBloco = false, regex = false, classe = false;

// Depois de um destes, uma "/" começa uma EXPRESSÃO REGULAR, não é divisão.
// Sem isto o miolo da regex entra no código limpo, e `/Full/i.test(x)` vira uma
// variável chamada Full que ninguém declarou. Foram 8 alarmes falsos assim.
const ANTES_DE_REGEX = /[(,=:[!&|?{};+\-*%~^]$|\b(?:return|typeof|instanceof|in|of|case|new|delete|void|do|else)$/;

for (let i = 0; i < src.length; i++) {
  const c = src[i], prox = src[i + 1];

  if (comLinha) { if (c === '\n') { comLinha = false; limpo += '\n'; } continue; }
  if (comBloco) { if (c === '*' && prox === '/') { comBloco = false; i++; } continue; }
  if (regex) {
    if (escapa) { escapa = false; continue; }
    if (c === '\\') { escapa = true; continue; }
    // Uma classe [ ... ] pode conter "/" sem terminar a regex. Precisa de bandeira
    // PRÓPRIA: na primeira versão eu reaproveitei a de texto, e ela continuava ligada
    // depois que a regex acabava — daí em diante o validador engolia o código até
    // achar um "]" solto, e a conta de parênteses saía errada.
    if (classe) { if (c === ']') classe = false; continue; }
    if (c === '[') { classe = true; continue; }
    if (c === '/') { regex = false; while (/[a-z]/.test(src[i + 1] || '')) i++; }
    continue;
  }
  if (str) {
    if (escapa) { escapa = false; continue; }
    if (c === '\\') { escapa = true; continue; }
    if (c === str) str = null;
    continue;
  }
  if (c === '/' && prox === '/') { comLinha = true; i++; continue; }
  if (c === '/' && prox === '*') { comBloco = true; i++; continue; }
  if (c === '/' && ANTES_DE_REGEX.test(limpo.trimEnd())) { regex = true; limpo += '0'; continue; }
  if (c === '"' || c === "'" || c === '`') { str = c; limpo += '""'; continue; }

  if (c === '(') par++; else if (c === ')') par--;
  else if (c === '{') chav++; else if (c === '}') chav--;
  else if (c === '[') colch++; else if (c === ']') colch--;
  limpo += c;
}

console.log(`  parênteses ${par} · chaves ${chav} · colchetes ${colch}`);
if (par || chav || colch) {
  console.error('  ❌ DESBALANCEADO — não publique');
  process.exit(1);
}

// ── 2. Nomes usados que não são declarados em lugar nenhum ──────────────────
//
// Não é análise de escopo de verdade: a pergunta é só "esse nome aparece declarado
// EM ALGUM LUGAR do arquivo?". Um nome usado e nunca declarado é erro certo. O
// contrário (declarado num escopo e usado em outro) escapa — mas esse caso é raro
// aqui, e o barato pega justamente o deslize de apagar código pela metade.

const declarados = new Set();
const declara = (nome) => { if (nome) declarados.add(nome); };
const paramsDe = (texto) => texto.split(',').forEach((p) => {
  const nome = p.trim().replace(/=.*$/, '').trim();
  if (/^[A-Za-z_$][\w$]*$/.test(nome)) declara(nome);
});

// `var ma = f(a), mb = f(b);` declara DOIS nomes. Pegar só o primeiro deu 4 alarmes
// falsos — então lê a declaração inteira, até o ; ou o fim da linha, e recolhe todos
// os nomes que vêm logo depois de uma vírgula no nível de cima.
for (const x of limpo.matchAll(/\b(?:var|let|const)\s+([^;\n]*)/g)) {
  let nivel = 0, atual = '';
  const pedacos = [];
  for (const c of x[1]) {
    if ('([{'.includes(c)) nivel++;
    else if (')]}'.includes(c)) nivel--;
    if (c === ',' && nivel === 0) { pedacos.push(atual); atual = ''; continue; }
    atual += c;
  }
  pedacos.push(atual);
  pedacos.forEach((p) => {
    const nome = p.trim().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(nome)) declara(nome);
  });
}
for (const x of limpo.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declara(x[1]);
for (const x of limpo.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declara(x[1]);
for (const x of limpo.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) paramsDe(x[1]);
for (const x of limpo.matchAll(/\bcatch\s*\(([^)]*)\)/g)) paramsDe(x[1]);
for (const x of limpo.matchAll(/\(([^()]*)\)\s*=>/g)) paramsDe(x[1]);
for (const x of limpo.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) declara(x[1]);
// Desestruturação: var {a, b} = ... e var [a, b] = ...
for (const x of limpo.matchAll(/\b(?:var|let|const)\s*[{[]([^}\]]*)[}\]]/g)) paramsDe(x[1]);

const CONHECIDOS = new Set([
  // JavaScript
  'true', 'false', 'null', 'undefined', 'this', 'arguments', 'NaN', 'Infinity',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'Promise', 'Map', 'Set', 'Symbol', 'parseInt', 'parseFloat', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'Intl',
  // navegador
  'window', 'document', 'console', 'alert', 'confirm', 'prompt', 'fetch', 'navigator',
  'location', 'localStorage', 'sessionStorage', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'FileReader', 'Blob',
  'URL', 'FormData', 'Image', 'Audio', 'AbortController', 'Uint8Array', 'atob', 'btoa',
  'CustomEvent', 'Event', 'MutationObserver', 'ResizeObserver', 'getComputedStyle',
  // bibliotecas carregadas por <script src>
  'React', 'ReactDOM', 'Babel', 'XLSX', 'supabase', 'Chart', 'JsBarcode', 'html2canvas',
  // palavras-chave que a regex pode capturar como identificador
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'try', 'catch', 'finally', 'function', 'var', 'let', 'const', 'class', 'extends',
  'super', 'yield', 'await', 'async', 'static', 'get', 'set',
]);

// Todos os identificadores usados de verdade: fora de string/comentário, não vindo
// depois de um ponto (propriedade) e não seguido de dois-pontos (chave de objeto).
const usados = new Map();
const re = /(\.\s*)?\b([A-Za-z_$][\w$]*)\b(\s*:)?/g;
let achado;
while ((achado = re.exec(limpo)) !== null) {
  if (achado[1] || achado[3]) continue;          // propriedade ou chave de objeto
  const nome = achado[2];
  if (CONHECIDOS.has(nome) || declarados.has(nome)) continue;
  usados.set(nome, (usados.get(nome) || 0) + 1);
}

if (usados.size) {
  console.error('  ❌ NOME USADO E NUNCA DECLARADO — a página abre em branco:');
  for (const [nome, vezes] of [...usados].sort((a, b) => b[1] - a[1])) {
    // Mostra onde, no arquivo de verdade, pra não ter que caçar.
    const linha = html.split('\n').findIndex((l) => new RegExp('\\b' + nome + '\\b').test(l)) + 1;
    console.error(`     ${nome}  — usado ${vezes}×, 1ª vez por volta da linha ${linha}`);
  }
  process.exit(1);
}

console.log('  ✅ balanceado · nenhum nome solto');
