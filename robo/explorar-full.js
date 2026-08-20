// Leitura da área "Gestão de estoque Full" da Central de Vendedores.
//
// Como usar:   node explorar-full.js KMP        (ou ERP / LTS)
//              node explorar-full.js todas
//
// SOMENTE LEITURA: abre a página, espera carregar e lê os números. Não seleciona
// produto, não clica em nenhum botão de ação, não altera nada em loja nenhuma.
//
// Esta é a tela que a API oficial do Mercado Livre não expõe — é por aqui que se
// retira produto do Full, se oferece Full de novo e se reativa anúncio.

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste, identificarConta, CONTAS_VALIDAS } = require('./navegador');

// Descoberto explorando: a aba "Gestão de estoque Full" tem URL própria.
const URL_FULL = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Lê "757 un. de 4.320 un." → { usado: 757, total: 4320 }
function parUnidades(texto) {
  const m = String(texto).match(/([\d.]+)\s*un\.\s*de\s*([\d.]+)\s*un\./i);
  if (!m) return null;
  const n = (s) => parseInt(s.replace(/\./g, ''), 10);
  return { usado: n(m[1]), total: n(m[2]) };
}

async function lerConta(conta) {
  if (!sessaoExiste(conta)) {
    console.log(`  ${conta}: sem sessão salva — rode  npm run login -- ${conta}`);
    return null;
  }

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());
  const identidade = await identificarConta(navegador);

  await pagina.goto(URL_FULL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await pagina.waitForTimeout(10000); // a tela carrega os números por JavaScript

  const texto = await pagina.evaluate(() => document.body.innerText || '');
  const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);

  function depoisDe(rotulo, quantas = 1) {
    const i = linhas.findIndex((l) => l.toLowerCase() === rotulo.toLowerCase());
    return i === -1 ? null : linhas.slice(i + 1, i + 1 + quantas);
  }
  function valorDe(rotulo) {
    const v = depoisDe(rotulo, 1);
    return v && v[0] ? v[0] : null;
  }

  const totalResultados = (texto.match(/([\d.]+)\s+resultados/i) || [])[1] || null;
  const pequenos = parUnidades(linhas.find((l) => /un\.\s*de\s*[\d.]+\s*un\./i.test(l)) || '');
  const espacos = linhas.filter((l) => /un\.\s*de\s*[\d.]+\s*un\./i.test(l)).map(parUnidades);

  const dados = {
    conta,
    apelido: identidade.apelido,
    userId: identidade.userId,
    lido_em: new Date().toISOString(),
    produtos_no_full: totalResultados,
    espacos: {
      pequenos_e_medios: espacos[0] || null,
      grandes_e_extragrandes: espacos[1] || null,
    },
    status: {
      para_evitar_descarte: valorDe('Para evitar descarte'),
      sem_vendas_para_retirar: valorDe('Sem vendas para retirar'),
      inativos: valorDe('Inativos'),
      para_colocar_a_venda: valorDe('Para colocar à venda'),
      nao_oferecem_full: valorDe('Não oferecem Full'),
      para_impulsionar_vendas: valorDe('Para impulsionar vendas'),
      boa_qualidade: valorDe('Boa qualidade'),
      em_venda: valorDe('Em venda'),
      em_transferencia: valorDe('Em transferência'),
      em_revisao_fiscal: valorDe('Em revisão fiscal pelo Mercado Livre'),
      entrada_pendente: valorDe('Entrada pendente'),
    },
  };

  const arquivoPrint = path.join(__dirname, 'prints', `full-${conta}-${carimbo()}.png`);
  await pagina.screenshot({ path: arquivoPrint, fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(__dirname, 'prints', `full-${conta}.txt`), texto);
  fs.writeFileSync(path.join(__dirname, 'prints', `full-${conta}.json`), JSON.stringify(dados, null, 2));

  await navegador.close().catch(() => {});
  return dados;
}

function mostrar(d) {
  if (!d) return;
  console.log('');
  console.log(`  ${d.conta} — ${d.apelido}`);
  console.log('  ' + '─'.repeat(50));
  console.log(`  Produtos no Full : ${d.produtos_no_full || '?'}`);
  const p = d.espacos.pequenos_e_medios;
  const g = d.espacos.grandes_e_extragrandes;
  if (p) console.log(`  Espaço P/M       : ${p.usado} de ${p.total} un.  (${Math.round(p.usado / p.total * 100)}%)`);
  if (g) console.log(`  Espaço G/XG      : ${g.usado} de ${g.total} un.  (${Math.round(g.usado / g.total * 100)}%)`);
  console.log('');
  console.log('  Situação do estoque:');
  const rotulos = {
    para_evitar_descarte: 'Para evitar descarte',
    sem_vendas_para_retirar: '  · sem vendas, para retirar',
    inativos: '  · inativos',
    para_colocar_a_venda: 'Para colocar à venda',
    nao_oferecem_full: '  · não oferecem Full',
    para_impulsionar_vendas: 'Para impulsionar vendas',
    boa_qualidade: 'Boa qualidade',
    em_venda: '  · em venda',
    em_transferencia: '  · em transferência',
    em_revisao_fiscal: '  · em revisão fiscal',
    entrada_pendente: 'Entrada pendente',
  };
  Object.entries(rotulos).forEach(([k, r]) => {
    if (d.status[k]) console.log(`   ${r.padEnd(32)} ${d.status[k]}`);
  });
}

async function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  const contas = arg === 'todas' ? CONTAS_VALIDAS : [validarConta(process.argv[2])];

  console.log('');
  console.log('  Gestão de estoque Full — leitura (nada é alterado)');
  console.log('  ═══════════════════════════════════════════════════');

  const todos = [];
  for (const c of contas) {
    const d = await lerConta(c);
    if (d) { mostrar(d); todos.push(d); }
  }

  console.log('');
  console.log('  Arquivos salvos em robo/prints/ (print, texto e json por conta).');
  console.log('');
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  process.exit(1);
});
