// DIAGNÓSTICO — só leitura, pela API oficial. Não altera nada.
//
// Os anúncios em que o robô insiste sem sucesso aparecem na tela do Full como
// "Pausada"/"Inativa". A busca por SKU não os encontra. Aqui vamos pelo caminho
// que funciona: listamos os anúncios pausados e inativos da conta, lemos o
// user_product_id de cada um e casamos com os MLBU que o robô já tem.
//
// Assim descobrimos o item_id (MLB...) real de cada travado — que é o que falta
// pra reativar pela API oficial em vez de ficar batendo no painel.
//
// Como usar:  node achar-travados.js KMP

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

// Lista os ids de anúncios da conta com um dado status, paginando.
async function idsPorStatus(userId, status, auth) {
  const ids = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await fetch(
      `https://api.mercadolibre.com/users/${userId}/items/search?status=${status}&limit=100&offset=${offset}`,
      { headers: auth }
    );
    if (!r.ok) break;
    const j = await r.json();
    const lote = j.results || [];
    ids.push(...lote);
    if (lote.length < 100) break;
  }
  return ids;
}

// Lê os anúncios em blocos de 20 (limite do endpoint multiget)
async function detalhes(ids, auth) {
  const saida = [];
  for (let i = 0; i < ids.length; i += 20) {
    const bloco = ids.slice(i, i + 20);
    const r = await fetch(
      `https://api.mercadolibre.com/items?ids=${bloco.join(',')}`
      + `&attributes=id,title,status,sub_status,available_quantity,shipping,user_product_id`,
      { headers: auth }
    );
    if (!r.ok) continue;
    const j = await r.json();
    for (const x of j) if (x.code === 200 && x.body) saida.push(x.body);
  }
  return saida;
}

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  const sb = conectar();

  const { data: tok } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', conta).maybeSingle();
  if (!tok) throw new Error(`conta ${conta} não encontrada`);
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const { data: travados } = await sb.from('ml_patrulha_full')
    .select('codigo_ml, titulo, user_product_id, tentativas, passadas')
    .eq('conta', conta).is('resolvido_em', null).is('desistiu_em', null);

  if (!travados || !travados.length) { console.log(`\n  ${conta}: nada pendente.\n`); return; }

  const procurados = new Map(travados.filter((t) => t.user_product_id).map((t) => [t.user_product_id, t]));
  console.log(`\n  ${conta} — procurando ${procurados.size} anúncio(s) travado(s) pela API oficial\n`);

  const achados = new Map();
  for (const status of ['paused', 'inactive', 'active']) {
    const ids = await idSeguro(tok.user_id, status, auth);
    if (!ids.length) { console.log(`    ${status}: 0 anúncios`); continue; }
    const itens = await detalhes(ids, auth);
    let casaram = 0;
    for (const it of itens) {
      if (it.user_product_id && procurados.has(it.user_product_id)) {
        achados.set(it.user_product_id, it);
        casaram++;
      }
    }
    console.log(`    ${status}: ${ids.length} anúncios na conta, ${casaram} são os travados`);
  }

  console.log('');
  for (const [mlbu, t] of procurados) {
    const it = achados.get(mlbu);
    if (!it) { console.log(`  ${t.codigo_ml}  ${mlbu}  →  não encontrado na API`); continue; }
    console.log(`  ${t.codigo_ml}  ${it.id}`);
    console.log(`     titulo ......... ${(it.title || '').slice(0, 60)}`);
    console.log(`     status ......... ${it.status}`);
    console.log(`     sub_status ..... ${(it.sub_status || []).join(', ') || '-'}`);
    console.log(`     unidades ....... ${it.available_quantity}`);
    console.log(`     logistica ...... ${it.shipping?.logistic_type || '-'}`);
  }
  console.log('');
}

async function idSeguro(userId, status, auth) {
  try { return await idsPorStatus(userId, status, auth); } catch (_e) { return []; }
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
