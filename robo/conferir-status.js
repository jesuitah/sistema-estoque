// DIAGNÓSTICO — só leitura, pela API oficial. Não abre navegador, não clica.
//
// Pergunta: os anúncios em que o robô insiste sem sucesso estão pausados/inativos?
// Se estiverem, "Ofereça o Full novamente" não tem como funcionar — não dá pra pôr
// unidades à venda num anúncio que não está vendendo. Seria preciso reativar o
// anúncio ANTES de oferecer o Full.
//
// Como usar:  node conferir-status.js KMP

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  const sb = conectar();

  const { data: tok } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', conta).maybeSingle();
  if (!tok) throw new Error(`conta ${conta} não encontrada`);
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const { data: alvos } = await sb.from('ml_patrulha_full')
    .select('codigo_ml, titulo, user_product_id, tentativas')
    .eq('conta', conta).is('resolvido_em', null);

  if (!alvos || !alvos.length) { console.log('\n  Nenhum anúncio pendente nesta conta.\n'); return; }

  console.log(`\n  ${conta} — ${alvos.length} anúncio(s) em que o robô está insistindo\n`);

  for (const a of alvos) {
    // O código da tela é o SKU do vendedor. Procuramos o anúncio por ele.
    const url = `https://api.mercadolibre.com/users/${tok.user_id}/items/search`
      + `?seller_sku=${encodeURIComponent(a.codigo_ml)}&include_filters=true`;
    const r = await fetch(url, { headers: auth });
    const j = await r.json().catch(() => ({}));
    const ids = j.results || [];

    if (!ids.length) {
      console.log(`  ${a.codigo_ml}  →  a API não achou anúncio com esse SKU`);
      continue;
    }

    for (const id of ids.slice(0, 3)) {
      const ri = await fetch(
        `https://api.mercadolibre.com/items/${id}?attributes=id,status,sub_status,available_quantity,shipping,user_product_id`,
        { headers: auth }
      );
      const it = await ri.json().catch(() => ({}));
      console.log(`  ${a.codigo_ml}  ${id}`);
      console.log(`     status .............. ${it.status}`);
      console.log(`     sub_status .......... ${(it.sub_status || []).join(', ') || '-'}`);
      console.log(`     unidades ............ ${it.available_quantity}`);
      console.log(`     logistica ........... ${it.shipping?.logistic_type || '-'}`);
      console.log(`     tentativas do robô .. ${a.tentativas}`);
    }
  }
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
