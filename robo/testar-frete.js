// Sonda a API de custos de envio antes de montar qualquer coisa em cima dela.
//
// Só olha, não grava nada. A pergunta é: dá pra saber quanto o Matheus pagou de frete
// em cada venda, e dá pra ligar esse valor ao anúncio?
//
// Como usar:  node testar-frete.js KMP 6

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

const moeda = (v) => v == null ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ',');

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  const quantos = Number(process.argv[3] || 6);
  const sb = conectar();

  const { data: tok } = await sb.from('ml_tokens')
    .select('access_token').eq('conta', conta).maybeSingle();
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const { data: pedidos } = await sb.from('ml_pedidos')
    .select('ml_order_id, shipping_id, itens, valor_total, is_full, logistic_type')
    .eq('conta', conta).not('shipping_id', 'is', null)
    .order('data_criacao_ml', { ascending: false }).limit(quantos);

  for (const p of pedidos) {
    const itens = Array.isArray(p.itens) ? p.itens : [];
    const primeiro = itens[0] || {};
    console.log(`\n  pedido ${p.ml_order_id} · ${p.logistic_type || '?'}${p.is_full ? ' · FULL' : ''}`);
    console.log(`  ${(primeiro.title || primeiro.item_id || '?').toString().slice(0, 56)}`);
    console.log(`  ${itens.length} item(ns) · total ${moeda(p.valor_total)}`);

    const r = await fetch(`https://api.mercadolibre.com/shipments/${p.shipping_id}/costs`, { headers: auth });
    if (!r.ok) { console.log(`     custos: o ML respondeu ${r.status}`); continue; }
    const c = await r.json();

    const s = (c.senders || [])[0] || {};
    const rec = (c.receiver || {});
    console.log(`     quem pagou o quê:`);
    console.log(`       vendedor (você) .... ${moeda(s.cost)}`
      + (s.compensation ? ` · compensação ${moeda(s.compensation)}` : '')
      + (s.discounts ? ` · descontos: ${JSON.stringify(s.discounts)}` : ''));
    console.log(`       comprador .......... ${moeda(rec.cost)}`);
    console.log(`     campos que vieram: ${Object.keys(c).join(', ')}`);
    if (s.save != null) console.log(`       save ............. ${moeda(s.save)}`);
  }
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
