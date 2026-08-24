// Leitura produto a produto do estoque Full — SOMENTE LEITURA.
//
// Como usar:   node ler-full.js KMP        (ou ERP / LTS / todas)
//
// SEM NENHUM CLIQUE. A paginação é feita por endereço (?page=N), descoberto testando.
// Confira com:  grep -n "click" ler-full.js   →  não deve achar nada.
//
// Gera, por conta:
//   robo/prints/full-produtos-<CONTA>.json  — todos os produtos, estruturados
//   robo/prints/full-produtos-<CONTA>.csv   — o mesmo, pra abrir no Excel

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste, identificarConta, CONTAS_VALIDAS } = require('./navegador');

const BASE = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';
const ESPERA = 9000;
const MAX_PAGINAS = 30;

function num(txt) {
  if (!txt) return null;
  const m = String(txt).match(/(-?[\d.]+)\s*un\./i);
  if (m) return parseInt(m[1].replace(/\./g, ''), 10);
  const n = String(txt).replace(/[^\d-]/g, '');
  return n === '' ? null : parseInt(n, 10);
}

// Espera a TABELA existir de verdade, em vez de dormir um tempo fixo.
// Espera fixa foi um bug real: a LTS demora mais que as outras contas pra montar a
// tabela e o script concluía "0 produtos" numa conta que tinha 177.
async function esperarTabela(pagina) {
  await pagina
    .waitForFunction(() => /C[óo]digo ML/i.test(document.body.innerText || ''), { timeout: 45000 })
    .catch(() => {}); // se estourar, seguimos e a página simplesmente virá vazia
  await pagina.waitForTimeout(1500); // respiro pra terminar de pintar as linhas
}

async function lerPagina(pagina, numeroPagina) {
  const url = numeroPagina === 1 ? BASE : `${BASE}?page=${numeroPagina}`;
  await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await esperarTabela(pagina);

  return pagina.evaluate(() => {
    const limpar = (s) => (s || '').trim().replace(/\s+/g, ' ');
    const linhas = [...document.querySelectorAll('tr')].slice(1); // pula cabeçalho
    return linhas.map((tr) => {
      const c = [...tr.querySelectorAll('td,th')].map((x) => limpar(x.innerText));
      const bruto = c[0] || '';
      const codigo = (bruto.match(/C[óo]digo ML:\s*([A-Z0-9]+)/i) || [])[1] || null;
      const tamanho = (bruto.match(/\b(PEQUENO|M[ÉE]DIO|GRANDE|EXTRAGRANDE)\b/i) || [])[1] || null;
      const desempenho = (bruto.match(/\b(BAIXO DESEMPENHO|ALTO DESEMPENHO|M[ÉE]DIO DESEMPENHO)\b/i) || [])[1] || null;
      // o título fica entre o código e o tamanho
      let titulo = bruto;
      if (codigo) titulo = titulo.split(codigo).slice(1).join(codigo);
      titulo = titulo.replace(/^\s*[\+\d\s]*/, '');
      if (tamanho) titulo = titulo.split(new RegExp(tamanho, 'i'))[0];
      titulo = limpar(titulo).replace(/\s*\.\.\.$/, '');
      return { codigo_ml: codigo, titulo, tamanho, desempenho, celulas: c };
    }).filter((r) => r.codigo_ml);
  });
}

async function lerConta(conta) {
  if (!sessaoExiste(conta)) { console.log(`  ${conta}: sem sessão salva.`); return null; }

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());
  const identidade = await identificarConta(navegador);

  console.log('');
  console.log(`  ${conta} — ${identidade.apelido}`);

  const produtos = [];
  const vistos = new Set();

  for (let n = 1; n <= MAX_PAGINAS; n++) {
    const linhas = await lerPagina(pagina, n);
    if (linhas.length === 0) break;

    // se a página repetir o primeiro código, acabou a paginação
    if (vistos.has(linhas[0].codigo_ml)) break;

    let novos = 0;
    for (const l of linhas) {
      if (vistos.has(l.codigo_ml)) continue;
      vistos.add(l.codigo_ml);
      novos++;
      const c = l.celulas;
      const acao = c[8] || '';
      produtos.push({
        codigo_ml: l.codigo_ml,
        titulo: l.titulo,
        tamanho: l.tamanho,
        desempenho: l.desempenho,
        vendas_30d: num(c[1]),
        motivo: (c[1] || '').replace(/^[\d.]+\s*un\.\s*/, '').replace(/R\$\s*[\d.,]+\s*$/, '').trim() || null,
        estoque_medio_30d: num(c[2]),
        a_caminho: num(c[3]),
        nao_aptas_para_venda: num(c[4]),
        aptas_para_venda: num(c[5]),
        com_tempo_de_estoque: num(c[6]),
        tempo_ate_esgotar: c[7] || null,
        acao_sugerida: acao || null,
        prazo: (acao.match(/at[ée]\s+(\d{1,2}\/\w+)/i) || [])[1] || null,
      });
    }
    process.stdout.write(`    página ${n}: +${novos} (total ${produtos.length})\r`);
    if (novos === 0) break;
  }

  console.log(`    ${produtos.length} produtos lidos.                     `);

  const dados = { conta, apelido: identidade.apelido, lido_em: new Date().toISOString(), produtos };
  fs.writeFileSync(path.join(__dirname, 'prints', `full-produtos-${conta}.json`), JSON.stringify(dados, null, 2));

  const colunas = ['codigo_ml','titulo','tamanho','desempenho','vendas_30d','estoque_medio_30d','a_caminho','nao_aptas_para_venda','aptas_para_venda','tempo_ate_esgotar','prazo','acao_sugerida','motivo'];
  const csv = [colunas.join(';')].concat(
    produtos.map((p) => colunas.map((k) => `"${String(p[k] ?? '').replace(/"/g, '""')}"`).join(';'))
  ).join('\n');
  fs.writeFileSync(path.join(__dirname, 'prints', `full-produtos-${conta}.csv`), '﻿' + csv, 'utf8');

  await navegador.close().catch(() => {});
  return dados;
}

function resumir(d) {
  const p = d.produtos;
  const somar = (k) => p.reduce((s, x) => s + (x[k] || 0), 0);
  const contarPor = (k) => {
    const m = {};
    p.forEach((x) => { const v = x[k] || '(sem)'; m[v] = (m[v] || 0) + 1; });
    return m;
  };
  console.log('');
  console.log(`  ── ${d.conta} — resumo ──`);
  console.log(`     produtos                : ${p.length}`);
  console.log(`     unidades aptas p/ venda : ${somar('aptas_para_venda')}`);
  console.log(`     unidades NÃO aptas      : ${somar('nao_aptas_para_venda')}`);
  console.log(`     unidades a caminho      : ${somar('a_caminho')}`);
  console.log(`     sem nenhuma venda em 30d: ${p.filter((x) => !x.vendas_30d).length}`);
  console.log(`     com prazo de descarte   : ${p.filter((x) => x.prazo).length}`);
  console.log(`     por desempenho          : ${JSON.stringify(contarPor('desempenho'))}`);
}

async function main() {
  const arg = (process.argv[2] || 'KMP').toLowerCase();
  const contas = arg === 'todas' ? CONTAS_VALIDAS : [validarConta(process.argv[2])];

  console.log('');
  console.log('  Leitura do estoque Full, produto a produto (nada é alterado)');
  console.log('  ' + '═'.repeat(58));

  const todos = [];
  for (const c of contas) {
    const d = await lerConta(c);
    if (d) todos.push(d);
  }
  todos.forEach(resumir);

  console.log('');
  console.log('  Arquivos em robo/prints/ (json e csv por conta).');
  console.log('');
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  process.exit(1);
});
