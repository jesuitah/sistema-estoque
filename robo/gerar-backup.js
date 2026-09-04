// Monta um pacote completo do sistema pra guardar fora do computador
// (pen drive, nuvem, e-mail).
//
// Como usar:   node gerar-backup.js
//              node gerar-backup.js "E:\"        (grava direto no pen drive)
//
// O QUE ENTRA
//   • todo o programa (site, robô, documentação)
//   • os dados do banco em Excel, uma aba por tabela
//   • um LEIA-ME explicando o que fazer com aquilo
//
// O QUE NÃO ENTRA, DE PROPÓSITO
//   • robo/sessoes/  — são os cookies de login das lojas. Num pen drive perdido,
//     dariam acesso às contas do Mercado Livre. Refazer o login leva 2 minutos.
//   • .tokens.json e a tabela ml_tokens — mesma razão: são chaves de acesso.
//   • node_modules/  — são bibliotecas públicas, voltam com "npm install".

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const RAIZ = path.join(__dirname, '..');

// Dados de negócio. ml_tokens fica de fora por segurança (ver acima).
//
// Esta lista precisa crescer junto com o sistema. Em 04/09/2026 ela ainda era a de
// agosto: faltavam promoções, fretes e tarifas — justamente o trabalho mais recente,
// e o mais caro de refazer, porque veio de milhares de consultas à API do ML.
const TABELAS = [
  'estoque', 'precos', 'markup_marcas',
  'ml_anuncios', 'ml_pedidos', 'ml_templates_fotos',
  'kanban_listas', 'kanban_cartoes', 'kanban_itens',
  'kanban_etiquetas', 'kanban_cartao_etiquetas',
  'app_perfis', 'ml_log_acoes', 'ml_patrulha_full',
  'ml_patrulha_execucoes', 'ml_tarefas_robo', 'robo_alertas',
  'ml_promocoes_itens', 'ml_fretes', 'ml_frete_anuncio',
  'ml_frete_faixas', 'ml_tarifas',
];

// Pastas e arquivos que não vão junto
const IGNORAR = ['node_modules', 'sessoes', 'prints', '.git', '.claude', '.tokens.json', 'package-lock.json'];

function conectar() {
  const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

function copiarPasta(origem, destino) {
  fs.mkdirSync(destino, { recursive: true });
  let contagem = 0;
  for (const nome of fs.readdirSync(origem)) {
    if (IGNORAR.includes(nome)) continue;
    const de = path.join(origem, nome);
    const para = path.join(destino, nome);
    if (fs.statSync(de).isDirectory()) contagem += copiarPasta(de, para);
    else { fs.copyFileSync(de, para); contagem++; }
  }
  return contagem;
}

// Puxa a tabela inteira, em páginas (o Supabase devolve no máximo 1000 por vez)
async function baixarTabela(sb, tabela) {
  const linhas = [];
  const pagina = 1000;
  for (let inicio = 0; ; inicio += pagina) {
    const { data, error } = await sb.from(tabela).select('*').range(inicio, inicio + pagina - 1);
    if (error) return { erro: error.message };
    if (!data || !data.length) break;
    linhas.push(...data);
    if (data.length < pagina) break;
  }
  return { linhas };
}

// Objetos e listas viram texto, senão o Excel mostra "[object Object]"
function achatar(linha) {
  const saida = {};
  for (const [k, v] of Object.entries(linha)) {
    saida[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
  }
  return saida;
}

async function main() {
  const destinoBase = process.argv[2] || path.join(process.env.USERPROFILE || RAIZ, 'Desktop');
  const carimbo = new Date().toISOString().slice(0, 10);
  const destino = path.join(destinoBase, `BACKUP-Sistema-Estoque-${carimbo}`);

  console.log('');
  console.log('  Montando o pacote de segurança');
  console.log('  ' + '═'.repeat(50));

  fs.mkdirSync(destino, { recursive: true });

  // 1) programa e documentação
  const arquivos = copiarPasta(RAIZ, path.join(destino, 'programa'));
  console.log(`  ✓ programa e documentação — ${arquivos} arquivos`);

  // 2) dados
  const sb = conectar();
  const livro = XLSX.utils.book_new();
  let totalLinhas = 0;
  const resumo = [['Tabela', 'Linhas', 'Observação']];

  for (const tabela of TABELAS) {
    const r = await baixarTabela(sb, tabela);
    if (r.erro) {
      resumo.push([tabela, 0, 'não deu pra ler: ' + r.erro]);
      console.log(`  ✗ ${tabela}: ${r.erro}`);
      continue;
    }
    const linhas = r.linhas.map(achatar);
    const aba = XLSX.utils.json_to_sheet(linhas.length ? linhas : [{ vazia: true }]);
    XLSX.utils.book_append_sheet(livro, aba, tabela.slice(0, 31));
    totalLinhas += linhas.length;
    resumo.push([tabela, linhas.length, '']);
    process.stdout.write(`  ✓ ${tabela}: ${linhas.length} linhas          \r`);
  }
  console.log(`  ✓ dados do banco — ${totalLinhas} linhas no total          `);

  const abaResumo = XLSX.utils.aoa_to_sheet(resumo);
  abaResumo['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(livro, abaResumo, 'RESUMO');

  const arquivoDados = path.join(destino, `dados-${carimbo}.xlsx`);
  XLSX.writeFile(livro, arquivoDados);

  // 3) instruções na raiz do pacote
  fs.writeFileSync(path.join(destino, 'LEIA-ME.txt'),
`PACOTE DE SEGURANÇA — SISTEMA DE ESTOQUE
Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}

O QUE TEM AQUI

  programa\\          o site, o robô e toda a documentação
  dados-${carimbo}.xlsx   os dados do banco, uma aba por tabela (${totalLinhas} linhas)

COMO USAR ISTO

  Leia:  programa\\BACKUP SISTEMA DE ESTOQUE 04.09.md
  Ele tem o passo a passo pra reconstruir tudo num computador novo.

O QUE **NÃO** ESTÁ AQUI, DE PROPÓSITO

  As sessões de login das lojas e as chaves de acesso ficaram de fora por segurança:
  se este pen drive se perder, quem achar não entra nas suas contas.
  Refazer o login leva 2 minutos por loja — está explicado no arquivo acima.

O QUE VOCÊ PRECISA GUARDAR SEPARADO (não está aqui e não pode estar)

  • senha do GitHub      — usuário jesuitah, repositório sistema-estoque
  • senha do Supabase    — projeto pylkufhziohxvwbbaued
  • senhas das 3 contas do Mercado Livre (KMP, ERP, LTS)

  Sem essas, o pacote não reconstrói tudo. Guarde num gerenciador de senhas.

ESTE PACOTE ESTÁ DESATUALIZADO?

  Os dados mudam todo dia. Gere um novo quando quiser:
      cd caminho\\do\\projeto\\robo
      node gerar-backup.js

  Para gravar direto no pen drive:
      node gerar-backup.js "E:\\"
`);

  const tamanho = (function tamanhoDe(p) {
    let t = 0;
    for (const n of fs.readdirSync(p)) {
      const f = path.join(p, n);
      const s = fs.statSync(f);
      t += s.isDirectory() ? tamanhoDe(f) : s.size;
    }
    return t;
  })(destino);

  console.log('  ✓ LEIA-ME.txt');
  console.log('');
  console.log('  ' + '═'.repeat(50));
  console.log(`  Pronto: ${destino}`);
  console.log(`  Tamanho: ${(tamanho / 1024 / 1024).toFixed(1)} MB`);
  console.log('');
  console.log('  Copie essa pasta inteira para o pen drive.');
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
