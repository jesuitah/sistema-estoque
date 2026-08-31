// Conserta os títulos do histórico da patrulha.
//
// Os títulos vinham da tela do painel do ML, que corta com "..." e gruda o tamanho e o
// estado ("... PEQUENO Inativa"). Alguns nem título tinham, e o histórico mostrava só
// o código da peça. Aqui buscamos o nome real na API oficial e corrigimos.
//
// Roda uma vez. Daqui pra frente a patrulha já grava o nome certo.
//
// Como usar:  node arrumar-titulos.js

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function main() {
  const sb = conectar();

  // codigo_ml -> user_product_id, pra achar o anúncio na API
  const { data: mapa } = await sb.from('ml_patrulha_full')
    .select('conta, codigo_ml, user_product_id');
  const porCodigo = {};
  for (const m of mapa || []) {
    if (m.user_product_id) porCodigo[`${m.conta}:${m.codigo_ml}`] = m.user_product_id;
  }

  const tokens = {};
  for (const conta of ['KMP', 'ERP', 'LTS']) {
    const { data } = await sb.from('ml_tokens')
      .select('user_id, access_token').eq('conta', conta).maybeSingle();
    if (data) tokens[conta] = data;
  }

  // Registros da patrulha com título ruim: cortado, sujo, ou ausente
  const { data: linhas } = await sb.from('ml_log_acoes')
    .select('id, conta, item_id, title')
    .eq('acao', 'reativado').ilike('detalhe', '%Full%');

  const ruins = (linhas || []).filter((l) =>
    !l.title || /\.\.\.|PEQUENO|M[ÉE]DIO|GRANDE|Inativa|Pausada/i.test(l.title));

  console.log(`\n  ${ruins.length} de ${(linhas || []).length} registros com título ruim\n`);

  const cache = {};
  let arrumados = 0;

  for (const l of ruins) {
    const up = porCodigo[`${l.conta}:${l.item_id}`];
    const t = tokens[l.conta];
    if (!up || !t) continue;

    if (!cache[up]) {
      const auth = { Authorization: `Bearer ${t.access_token}` };
      const b = await fetch(
        `https://api.mercadolibre.com/users/${t.user_id}/items/search?user_product_id=${up}`,
        { headers: auth });
      const ids = b.ok ? ((await b.json()).results || []) : [];
      if (!ids.length) continue;
      const r = await fetch(`https://api.mercadolibre.com/items/${ids[0]}?attributes=id,title`, { headers: auth });
      if (!r.ok) continue;
      cache[up] = (await r.json()).title;
    }

    const nome = cache[up];
    if (!nome || nome === l.title) continue;
    await sb.from('ml_log_acoes').update({ title: nome }).eq('id', l.id);
    arrumados++;
    console.log(`  ${l.item_id} → ${nome.slice(0, 60)}`);
  }

  // Mesma limpeza na tabela de acompanhamento
  for (const [chave, up] of Object.entries(porCodigo)) {
    const nome = cache[up];
    if (!nome) continue;
    const [conta, codigo] = chave.split(':');
    await sb.from('ml_patrulha_full').update({ titulo: nome })
      .eq('conta', conta).eq('codigo_ml', codigo);
  }

  console.log(`\n  ${arrumados} título(s) corrigido(s)\n`);
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
