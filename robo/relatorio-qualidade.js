// Relatório de qualidade pra corrigir direto na plataforma do Mercado Livre.
//
// Como usar:   node relatorio-qualidade.js
//
// Só leitura. Gera robo/prints/RELATORIO-QUALIDADE.xlsx com três visões:
//
//   1. POR CAMPO      — "estes N anúncios precisam de Código OEM". É a visão mais
//                       produtiva: faz-se a mesma tarefa em lote.
//   2. GANHO RAPIDO   — anúncios a que falta UM único campo. Menor esforço, some
//                       da lista na hora.
//   3. TODOS          — um anúncio por linha, com tudo que falta e o link.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ARQUIVO_TOKENS = path.join(__dirname, '.tokens.json');
const SAIDA = path.join(__dirname, 'prints', 'RELATORIO-QUALIDADE.xlsx');

// Códigos oficiais que não se digitam à mão — não entram no relatório de trabalho.
const IGNORAR = [
  'REGULATORY_INFORMATION_QR_CODE',
  'INMETRO_CERTIFICATION_REGISTRATION_NUMBER',
  'SELLER_SKU', 'GTIN', 'CATALOG_TITLE', 'HAS_COMPATIBILITIES',
  'SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH',
  'SELLER_PACKAGE_WEIGHT', 'SELLER_PACKAGE_TYPE', 'SHIPMENT_PACKING',
  'PACKAGE_HEIGHT', 'PACKAGE_WIDTH', 'PACKAGE_LENGTH', 'PACKAGE_WEIGHT',
  'PRODUCT_FEATURES', 'EMPTY_GTIN_REASON',
];

const cacheAttrs = new Map();
const cacheNome = new Map();

async function attrsDaCategoria(catId, token) {
  if (cacheAttrs.has(catId)) return cacheAttrs.get(catId);
  const r = await fetch(`https://api.mercadolibre.com/categories/${catId}/attributes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const lista = r.ok ? await r.json() : [];
  const util = (Array.isArray(lista) ? lista : []).filter((a) => {
    if (IGNORAR.includes(a.id)) return false;
    if (a.tags?.read_only || a.tags?.hidden) return false;
    return a.tags?.required || a.tags?.catalog_required || a.tags?.conditional_required || a.relevance === 1;
  });
  cacheAttrs.set(catId, util);
  return util;
}

async function nomeCategoria(catId) {
  if (cacheNome.has(catId)) return cacheNome.get(catId);
  let nome = catId;
  try {
    const r = await fetch(`https://api.mercadolibre.com/categories/${catId}`);
    if (r.ok) nome = (await r.json()).name || catId;
  } catch (_e) { /* mantém o id */ }
  cacheNome.set(catId, nome);
  return nome;
}

// O número curto que aparece no painel do ML (sem o prefixo MLB)
function numeroCurto(itemId) {
  return String(itemId).replace(/^MLB/i, '');
}

async function main() {
  const contas = JSON.parse(fs.readFileSync(ARQUIVO_TOKENS, 'utf8'));
  const token = contas[0].access_token;

  let itens = [];
  for (const c of contas) {
    const arq = path.join(__dirname, 'prints', `qualidade-${c.conta}.json`);
    if (!fs.existsSync(arq)) continue;
    JSON.parse(fs.readFileSync(arq, 'utf8'))
      .filter((i) => typeof i.health === 'number')
      .forEach((i) => { i.conta = c.conta; itens.push(i); });
  }
  console.log(`  ${itens.length} anúncios abaixo da nota máxima.`);

  const analisados = [];
  for (const i of itens) {
    const attrs = await attrsDaCategoria(i.category_id, token);
    const preenchidos = new Set(
      (i.attributes || []).filter((a) => a.value_name || a.value_id).map((a) => a.id)
    );
    const faltam = attrs.filter((a) => !preenchidos.has(a.id));
    if (!faltam.length) continue;
    analisados.push({
      conta: i.conta,
      numero: numeroCurto(i.id),
      item_id: i.id,
      titulo: String(i.title || '').slice(0, 70),
      nota: i.health,
      categoria: await nomeCategoria(i.category_id),
      faltam: faltam.map((a) => a.name),
      link: i.permalink || '',
    });
    process.stdout.write(`    analisados ${analisados.length}\r`);
  }
  console.log(`    ${analisados.length} anúncios com campo faltando.        `);

  const livro = XLSX.utils.book_new();

  // ── 1. POR CAMPO ────────────────────────────────────────────────────────────
  const porCampo = {};
  analisados.forEach((a) => {
    a.faltam.forEach((f) => {
      (porCampo[f] ||= []).push(a);
    });
  });
  const linhasCampo = [['Campo que falta', 'Qtd. anúncios', 'Contas', 'Números dos anúncios (sem MLB)']];
  Object.entries(porCampo)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([campo, lista]) => {
      const contasEnv = [...new Set(lista.map((x) => x.conta))].join(', ');
      linhasCampo.push([campo, lista.length, contasEnv, lista.map((x) => x.numero).join(' ')]);
    });
  const abaCampo = XLSX.utils.aoa_to_sheet(linhasCampo);
  abaCampo['!cols'] = [{ wch: 40 }, { wch: 13 }, { wch: 16 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(livro, abaCampo, 'POR CAMPO');

  // ── 2. GANHO RÁPIDO (falta 1 só) ────────────────────────────────────────────
  const rapidos = analisados.filter((a) => a.faltam.length === 1)
    .sort((a, b) => a.faltam[0].localeCompare(b.faltam[0]));
  const linhasRap = [['Conta', 'Nº do anúncio', 'Falta só isto', 'Nota atual', 'Categoria', 'Título', 'Link']];
  rapidos.forEach((a) => linhasRap.push([a.conta, a.numero, a.faltam[0], a.nota, a.categoria, a.titulo, a.link]));
  const abaRap = XLSX.utils.aoa_to_sheet(linhasRap);
  abaRap['!cols'] = [{ wch: 7 }, { wch: 14 }, { wch: 34 }, { wch: 10 }, { wch: 26 }, { wch: 55 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(livro, abaRap, 'GANHO RAPIDO');

  // ── 3. TODOS ────────────────────────────────────────────────────────────────
  const todos = [...analisados].sort((a, b) => a.faltam.length - b.faltam.length || a.nota - b.nota);
  const linhasTodos = [['Conta', 'Nº do anúncio', 'Qtd. faltando', 'O que falta', 'Nota atual', 'Categoria', 'Título', 'Link']];
  todos.forEach((a) => linhasTodos.push([
    a.conta, a.numero, a.faltam.length, a.faltam.join(', '), a.nota, a.categoria, a.titulo, a.link,
  ]));
  const abaTodos = XLSX.utils.aoa_to_sheet(linhasTodos);
  abaTodos['!cols'] = [{ wch: 7 }, { wch: 14 }, { wch: 12 }, { wch: 60 }, { wch: 10 }, { wch: 26 }, { wch: 55 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(livro, abaTodos, 'TODOS');

  XLSX.writeFile(livro, SAIDA);

  console.log('');
  console.log(`  ✅ ${SAIDA}`);
  console.log(`     anúncios a corrigir : ${analisados.length}`);
  console.log(`     falta 1 campo só    : ${rapidos.length}  ← comece por aqui`);
  console.log('');
  console.log('  Campos que mais aparecem:');
  Object.entries(porCampo).sort((a, b) => b[1].length - a[1].length).slice(0, 8)
    .forEach(([c, l]) => console.log(`     ${String(l.length).padStart(4)}  ${c}`));
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
