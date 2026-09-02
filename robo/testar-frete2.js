// Segunda sonda do frete: existe uma fonte que valha para TODOS os anúncios com frete
// grátis, e não só para os 37% que venderam nos últimos dois meses?
//
// Compara, nos anúncios que já venderam, o que a API diz com o que foi pago de verdade.
// Se bater, dá pra usar a API em todo mundo. Se não bater, o histórico é a única
// verdade e o resto fica sem número.
//
// Só olha, não grava nada.
//
// Como usar:  node testar-frete2.js KMP

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
  const sb = conectar();

  const { data: tok } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', conta).maybeSingle();
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  // Pega alguns pedidos recentes: sabemos o item e sabemos quanto foi pago.
  const { data: pedidos } = await sb.from('ml_pedidos')
    .select('ml_order_id, shipping_id, itens')
    .eq('conta', conta).not('shipping_id', 'is', null)
    .order('data_criacao_ml', { ascending: false }).limit(8);

  for (const p of pedidos) {
    const it = (Array.isArray(p.itens) ? p.itens : [])[0];
    const itemId = it && it.item && it.item.id;
    if (!itemId) continue;

    // 1) o que foi pago de verdade
    let pago = null;
    const rc = await fetch(`https://api.mercadolibre.com/shipments/${p.shipping_id}/costs`, { headers: auth });
    if (rc.ok) { const c = await rc.json(); pago = ((c.senders || [])[0] || {}).cost; }

    console.log(`\n  ${itemId}  ${(it.item.title || '').slice(0, 50)}`);
    console.log(`     pago de verdade ......... ${moeda(pago)}`);

    // 2) o que o anúncio diz sobre o frete dele
    const ri = await fetch(
      `https://api.mercadolibre.com/items/${itemId}?attributes=price,shipping,dimensions`,
      { headers: auth });
    if (ri.ok) {
      const j = await ri.json();
      console.log(`     preço ${moeda(j.price)} · frete grátis: ${j.shipping && j.shipping.free_shipping ? 'sim' : 'não'}`
        + (j.shipping && j.shipping.dimensions ? ` · dimensões ${j.shipping.dimensions}` : ''));
      if (j.shipping && j.shipping.free_methods) {
        console.log(`     free_methods: ${JSON.stringify(j.shipping.free_methods)}`);
      }
    }

    // 3) o custo que o ML calcula para este anúncio, sem precisar de venda
    const rf = await fetch(
      `https://api.mercadolibre.com/items/${itemId}/shipping_options/free`, { headers: auth });
    if (!rf.ok) {
      console.log(`     shipping_options/free: o ML respondeu ${rf.status}`);
    } else {
      const f = await rf.json();
      const opcoes = f.coverage && f.coverage.all_country ? f.coverage.all_country : null;
      console.log(`     calculado pela API ...... ${opcoes ? moeda(opcoes.list_cost) : JSON.stringify(f).slice(0, 200)}`);
    }
  }
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
