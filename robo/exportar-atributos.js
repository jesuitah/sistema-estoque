// Gera a planilha pro Matheus preencher os atributos que faltam nos anúncios.
//
// Como usar:   node exportar-atributos.js            (top 15 categorias)
//              node exportar-atributos.js 30         (top 30 categorias)
//
// Só leitura. Produz robo/prints/ATRIBUTOS-PARA-PREENCHER.xlsx
//
// Organização: uma ABA por categoria (peças do mesmo tipo juntas, mesmas colunas).
// As 10 maiores categorias concentram ~70% dos anúncios, então poucas abas já
// resolvem a maior parte.
//
// Regras da planilha:
//   • célula VAZIA  = precisa preencher
//   • "já ok"       = esse anúncio já tem o atributo, pule
//   • o cabeçalho mostra as opções aceitas quando o campo é de lista fechada

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ARQUIVO_TOKENS = path.join(__dirname, '.tokens.json');
const SAIDA = path.join(__dirname, 'prints', 'ATRIBUTOS-PARA-PREENCHER.xlsx');

// Campos que não vale a pena pedir pro humano preencher à mão.
const IGNORAR = [
  'REGULATORY_INFORMATION_QR_CODE',   // QR regulatório: não se digita
  'INMETRO_CERTIFICATION_REGISTRATION_NUMBER', // registro oficial, não se inventa
  'SELLER_SKU', 'GTIN', 'CATALOG_TITLE', 'HAS_COMPATIBILITIES',
  'SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH',
  'SELLER_PACKAGE_WEIGHT', 'SELLER_PACKAGE_TYPE', 'SHIPMENT_PACKING',
  'PACKAGE_HEIGHT', 'PACKAGE_WIDTH', 'PACKAGE_LENGTH', 'PACKAGE_WEIGHT',
  'PRODUCT_FEATURES', 'EMPTY_GTIN_REASON',
];

const cacheCategoria = new Map();
const cacheNome = new Map();

// Nome legível da categoria — "Bieletas" diz muito mais que "MLB63788" pra quem
// vai preencher a planilha.
async function nomeDaCategoria(categoriaId) {
  if (cacheNome.has(categoriaId)) return cacheNome.get(categoriaId);
  let nome = categoriaId;
  try {
    const r = await fetch(`https://api.mercadolibre.com/categories/${categoriaId}`);
    if (r.ok) {
      const j = await r.json();
      if (j.name) nome = j.name;
    }
  } catch (_e) { /* fica o id mesmo */ }
  cacheNome.set(categoriaId, nome);
  return nome;
}

// Nome de aba do Excel: máx. 31 caracteres e sem : \ / ? * [ ]
function nomeDeAba(texto) {
  return texto.replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
}

async function atributosDaCategoria(categoriaId, token) {
  if (cacheCategoria.has(categoriaId)) return cacheCategoria.get(categoriaId);
  const r = await fetch(`https://api.mercadolibre.com/categories/${categoriaId}/attributes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const lista = r.ok ? await r.json() : [];
  const util = (Array.isArray(lista) ? lista : []).filter((a) => {
    if (IGNORAR.includes(a.id)) return false;
    if (a.tags?.read_only || a.tags?.hidden) return false;
    const exigido = a.tags?.required || a.tags?.catalog_required;
    const sugerido = a.tags?.conditional_required || a.relevance === 1;
    return exigido || sugerido;
  });
  cacheCategoria.set(categoriaId, util);
  return util;
}

// Cabeçalho amigável, já mostrando as opções aceitas quando existem
function cabecalho(attr) {
  const opcoes = (attr.values || []).map((v) => v.name).filter(Boolean);
  if (opcoes.length && opcoes.length <= 6) return `${attr.name} (${opcoes.join(' | ')})`;
  if (opcoes.length) return `${attr.name} (lista — ver aba OPÇÕES)`;
  if (attr.value_type === 'number_unit') return `${attr.name} (número + unidade, ex: 10 cm)`;
  if (attr.value_type === 'boolean') return `${attr.name} (Sim | Não)`;
  return attr.name;
}

async function main() {
  const limiteCategorias = parseInt(process.argv[2] || '15', 10);
  const contas = JSON.parse(fs.readFileSync(ARQUIVO_TOKENS, 'utf8'));
  const tokenQualquer = contas[0].access_token;

  // junta os anúncios abaixo da nota máxima
  let itens = [];
  for (const c of contas) {
    const arq = path.join(__dirname, 'prints', `qualidade-${c.conta}.json`);
    if (!fs.existsSync(arq)) continue;
    JSON.parse(fs.readFileSync(arq, 'utf8'))
      .filter((i) => typeof i.health === 'number')
      .forEach((i) => { i.conta = c.conta; itens.push(i); });
  }
  console.log(`  ${itens.length} anúncios abaixo da nota máxima.`);

  // agrupa por categoria, das maiores pras menores
  const porCategoria = {};
  itens.forEach((i) => { (porCategoria[i.category_id] ||= []).push(i); });
  const categorias = Object.entries(porCategoria)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limiteCategorias);

  const livro = XLSX.utils.book_new();
  const legenda = [['Categoria', 'Atributo', 'ID do atributo', 'Opções aceitas']];
  let totalCelulas = 0;

  // aba de instruções
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([
    ['COMO PREENCHER'],
    [''],
    ['1. Cada aba é uma categoria de peça. As colunas são o que falta naquele tipo de produto.'],
    ['2. Célula VAZIA = precisa preencher.'],
    ['3. Onde estiver escrito "já ok" = esse anúncio já tem o atributo. Pule.'],
    ['4. Não mexa nas colunas item_id, conta, titulo e nota — elas identificam o anúncio.'],
    ['5. Quando o cabeçalho mostrar opções entre parênteses, use EXATAMENTE uma delas.'],
    ['6. Pode deixar em branco o que você não souber. Em branco é melhor que errado.'],
    ['7. Quando terminar, salve e mande o arquivo de volta.'],
    [''],
    ['Campos que NÃO estão aqui de propósito: QR regulatório e registro INMETRO'],
    ['(são códigos oficiais, não se preenchem à mão), e dimensões de embalagem'],
    ['(essas já são tratadas pelo sistema).'],
  ]), 'LEIA-ME');

  for (const [categoriaId, lista] of categorias) {
    const attrs = await atributosDaCategoria(categoriaId, tokenQualquer);
    if (!attrs.length) continue;

    // só interessam os atributos que faltam em pelo menos um anúncio da categoria
    const relevantes = attrs.filter((a) =>
      lista.some((i) => !(i.attributes || []).some((x) => x.id === a.id && (x.value_name || x.value_id)))
    );
    if (!relevantes.length) continue;

    const cab = ['item_id', 'conta', 'titulo', 'nota', ...relevantes.map(cabecalho)];
    const linhas = [cab];

    for (const i of lista) {
      const preenchidos = new Set(
        (i.attributes || []).filter((a) => a.value_name || a.value_id).map((a) => a.id)
      );
      const linha = [i.id, i.conta, String(i.title || '').slice(0, 70), i.health];
      relevantes.forEach((a) => {
        if (preenchidos.has(a.id)) linha.push('já ok');
        else { linha.push(''); totalCelulas++; }
      });
      linhas.push(linha);
    }

    const nome = await nomeDaCategoria(categoriaId);
    const nomeAba = nomeDeAba(`${nome} (${lista.length})`);
    const aba = XLSX.utils.aoa_to_sheet(linhas);
    aba['!cols'] = [{ wch: 14 }, { wch: 6 }, { wch: 45 }, { wch: 6 }, ...relevantes.map(() => ({ wch: 22 }))];
    XLSX.utils.book_append_sheet(livro, aba, nomeAba);

    relevantes.forEach((a) => {
      const opcoes = (a.values || []).map((v) => v.name).filter(Boolean);
      legenda.push([nome, a.name, a.id, opcoes.join(' | ') || '(texto livre)']);
    });

    console.log(`    ${nomeAba.padEnd(22)} ${lista.length} anúncios · ${relevantes.length} campos`);
  }

  const abaLeg = XLSX.utils.aoa_to_sheet(legenda);
  abaLeg['!cols'] = [{ wch: 12 }, { wch: 34 }, { wch: 30 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(livro, abaLeg, 'OPÇÕES');

  XLSX.writeFile(livro, SAIDA);
  console.log('');
  console.log(`  ✅ Planilha gerada: ${SAIDA}`);
  console.log(`     ${totalCelulas} campos a preencher no total.`);
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
