// BACKUP SEMANAL — toda segunda-feira de manhã, sozinho.
//
// COMO O MATHEUS PEDIU (19/10/2026)
//   · uma pasta só, na Área de Trabalho
//   · um arquivo por segunda, e só as 4 últimas — nada de "093293203 backups"
//   · sem ninguém precisar clicar
//
// POR QUE AUTOMÁTICO: existe o botão "Backup" na tela desde sempre, manual. Em
// 19/10/2026 fui ver quando foi usado pela última vez: 8 de setembro. Um mês e meio.
// Backup que depende de alguém lembrar não é backup, é intenção.
//
// O QUE ENTRA: os dados do banco, uma aba por tabela. Só isso — o programa em si já
// está no GitHub, versionado, e copiá-lo toda semana só engorda o arquivo.
//
// O QUE NÃO ENTRA, DE PROPÓSITO: `ml_tokens`. São as chaves de acesso das 3 contas do
// Mercado Livre. Num arquivo na Área de Trabalho, ou num pen drive perdido, dariam a
// qualquer um o controle das lojas. Refazer o login leva 2 minutos; o estrago, não.
//
// SE O PC ESTIVER DESLIGADO NA SEGUNDA, não perde a semana: o robô confere de hora em
// hora e, assim que liga, vê que a segunda já passou sem backup e faz na hora.
//
// Rodar na mão:  node robo/backup-semanal.js

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const PASTA = path.join(process.env.USERPROFILE || path.join(__dirname, '..'),
  'Desktop', 'BACKUP SISTEMA');
const QUANTOS_GUARDAR = 4;   // um mês de histórico

// As mesmas do backup completo, menos ml_tokens. Esta lista precisa crescer junto com
// o sistema: em 04/09/2026 ela ainda era a de agosto e faltavam promoções, fretes e
// tarifas — justamente o mais caro de refazer, porque veio de milhares de consultas
// à API do Mercado Livre.
const TABELAS = [
  'estoque', 'precos', 'markup_marcas',
  'ml_anuncios', 'ml_pedidos', 'ml_templates_fotos',
  'kanban_listas', 'kanban_cartoes', 'kanban_itens',
  'kanban_etiquetas', 'kanban_cartao_etiquetas',
  'app_perfis', 'ml_log_acoes', 'ml_patrulha_full',
  'ml_patrulha_execucoes', 'ml_tarefas_robo', 'robo_alertas',
  'ml_promocoes_itens', 'ml_fretes', 'ml_frete_anuncio',
  'ml_frete_faixas', 'ml_tarifas', 'ml_conversas', 'ml_reclamacoes',
  'flex_isentos',
];

function conectar() {
  const chave = require('./chave').chaveDoSupabase();
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

// A segunda-feira desta semana, às 00:00. É a régua: se o backup mais novo for
// anterior a ela, a semana ainda não foi feita.
function segundaDestaSemana(agora = new Date()) {
  const d = new Date(agora);
  d.setHours(0, 0, 0, 0);
  const diaDaSemana = d.getDay();              // 0 = domingo, 1 = segunda
  const recuo = diaDaSemana === 0 ? 6 : diaDaSemana - 1;
  d.setDate(d.getDate() - recuo);
  return d;
}

function nomeDoArquivo(data) {
  const p = (n) => String(n).padStart(2, '0');
  return `Backup-${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}.xlsx`;
}

// Os backups que já existem na pasta, do mais novo para o mais velho.
function backupsExistentes() {
  if (!fs.existsSync(PASTA)) return [];
  return fs.readdirSync(PASTA)
    .filter((n) => /^Backup-\d{4}-\d{2}-\d{2}\.xlsx$/.test(n))
    .map((n) => ({ nome: n, data: new Date(n.slice(7, 17) + 'T00:00:00') }))
    .sort((a, b) => b.data - a.data);
}

function precisaFazer(agora = new Date()) {
  const existentes = backupsExistentes();
  if (!existentes.length) return true;
  return existentes[0].data < segundaDestaSemana(agora);
}

async function baixarTabela(sb, tabela) {
  const linhas = [];
  for (let inicio = 0; ; inicio += 1000) {
    const { data, error } = await sb.from(tabela).select('*').range(inicio, inicio + 999);
    if (error) return { erro: error.message };
    if (!data || !data.length) break;
    linhas.push(...data);
    if (data.length < 1000) break;
  }
  return { linhas };
}

// Objeto e lista viram texto, senão o Excel mostra "[object Object]".
function achatar(linha) {
  const saida = {};
  for (const [k, v] of Object.entries(linha)) {
    saida[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
  }
  return saida;
}

async function fazerBackup(log = console.log) {
  const sb = conectar();
  const livro = XLSX.utils.book_new();
  const resumo = [['Tabela', 'Linhas', 'Observação']];
  let total = 0;
  const falhas = [];

  for (const tabela of TABELAS) {
    const r = await baixarTabela(sb, tabela);
    if (r.erro) {
      resumo.push([tabela, 0, 'não deu pra ler: ' + r.erro]);
      falhas.push(tabela);
      continue;
    }
    const linhas = r.linhas.map(achatar);
    const aba = XLSX.utils.json_to_sheet(linhas.length ? linhas : [{ vazia: true }]);
    XLSX.utils.book_append_sheet(livro, aba, tabela.slice(0, 31));
    resumo.push([tabela, linhas.length, '']);
    total += linhas.length;
  }

  // A primeira aba é o resumo: abriu o arquivo, já vê o que tem dentro.
  const abaResumo = XLSX.utils.aoa_to_sheet([
    ['BACKUP DO SISTEMA DE ESTOQUE'],
    ['Gerado em', new Date().toLocaleString('pt-BR')],
    ['Total de linhas', total],
    ['Observação', 'ml_tokens fica de fora de propósito: são as chaves das contas do Mercado Livre.'],
    [],
    ...resumo,
  ]);
  abaResumo['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 70 }];
  // Entra na frente de todas.
  livro.SheetNames.unshift('RESUMO');
  livro.Sheets['RESUMO'] = abaResumo;

  fs.mkdirSync(PASTA, { recursive: true });
  const destino = path.join(PASTA, nomeDoArquivo(new Date()));
  XLSX.writeFile(livro, destino);

  // Guarda só as 4 últimas segundas.
  const sobrando = backupsExistentes().slice(QUANTOS_GUARDAR);
  for (const velho of sobrando) {
    try { fs.unlinkSync(path.join(PASTA, velho.nome)); } catch (_e) { /* já sumiu */ }
  }

  const tamanho = (fs.statSync(destino).size / 1048576).toFixed(1);
  log(`  backup semanal: ${total} linhas, ${tamanho} MB → ${destino}`);
  if (falhas.length) log(`  ⚠ não entraram no backup: ${falhas.join(', ')}`);
  if (sobrando.length) log(`  (apaguei ${sobrando.length} backup(s) com mais de um mês)`);

  return { destino, total, falhas, apagados: sobrando.length };
}

// Chamado pelo robô de hora em hora: só faz se a semana ainda não tiver backup.
async function backupSemanalSePrecisar(log = console.log) {
  if (!precisaFazer()) return null;
  return fazerBackup(log);
}

module.exports = { fazerBackup, backupSemanalSePrecisar, precisaFazer, PASTA };

if (require.main === module) {
  fazerBackup().then(
    () => process.exit(0),
    (e) => { console.error('  parou:', e.message); process.exit(1); },
  );
}
