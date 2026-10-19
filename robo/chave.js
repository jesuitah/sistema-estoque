// A CHAVE DO SUPABASE PARA OS PROGRAMAS QUE RODAM NESTE PC.
//
// POR QUE ISTO EXISTE (19/10/2026)
//
// O site é um arquivo só, publicado no GitHub Pages a partir de um repositório
// PÚBLICO. A chave que ele usa está escrita dentro do index.html — tem que estar, é
// assim que um site estático fala com o banco. Ou seja: qualquer pessoa que ache o
// repositório tem essa chave.
//
// Isso seria inofensivo se as tabelas tivessem tranca. Não tinham. Com a chave do site
// dava pra ler a tabela `ml_tokens`, que guarda os tokens de acesso das 3 contas do
// Mercado Livre — e com eles, mexer nos anúncios, nos preços e nos pedidos das lojas.
// Conferido em 19/10/2026: a consulta respondeu 200 e devolveu o token.
//
// A correção tem duas pontas. Esta é a primeira: os programas do robô, que rodam só
// aqui no PC, passam a usar a CHAVE DE SERVIÇO — guardada no arquivo `.chave-servico`,
// que o .gitignore nunca deixa subir. Com isso dá pra trancar a `ml_tokens` sem que o
// robô pare, porque a chave de serviço passa por cima da tranca.
//
// O site continua com a chave pública e continua sem enxergar `ml_tokens` — ele nunca
// precisou dessa tabela.
//
// Enquanto o arquivo não existir, cai na chave do site e tudo funciona como antes:
// assim dá pra trocar os programas primeiro e trancar o banco depois, sem janela de
// sistema quebrado no meio.

const fs = require('fs');
const path = require('path');

const ARQUIVO_LOCAL = path.join(__dirname, '.chave-servico');

let avisou = false;

function chaveDoSupabase() {
  // 1. Variável de ambiente, se alguém quiser rodar com outra chave pontualmente.
  if (process.env.SUPABASE_KEY) return process.env.SUPABASE_KEY.trim();

  // 2. A chave de serviço deste PC.
  try {
    if (fs.existsSync(ARQUIVO_LOCAL)) {
      const chave = fs.readFileSync(ARQUIVO_LOCAL, 'utf8').trim();
      if (chave) return chave;
    }
  } catch (_e) { /* cai para a chave do site */ }

  // 3. A chave pública do site. Funciona, mas não abre a `ml_tokens` depois da tranca.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('não achei a chave do Supabase no index.html');
  if (!avisou) {
    avisou = true;
    console.log('  (usando a chave pública do site — crie robo/.chave-servico com a chave de serviço)');
  }
  return m[1];
}

module.exports = { chaveDoSupabase, ARQUIVO_LOCAL };
