// EXPERIMENTO CONTROLADO — testa a sequência VALIDATE → ACTION em UM anúncio.
//
// O robô disparava só a ação em lote (MAKE_OFFER_FULL): 31 tentativas, zero efeito.
// A suspeita é que o painel faz DOIS passos — valida (abre o modal) e depois confirma
// (o botão do modal) — e que é o segundo que executa de verdade.
//
// Aqui fazemos SÓ a sequência nova, num anúncio só, e conferimos o resultado pela
// API oficial (logistic_type). Sem repetir, sem lote, sem chute.
//
// Como usar:  node testar-sequencia.js ERP ZRJK92424 MLB3814983457

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { abrirNavegador } = require('./navegador');

const PAINEL = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';
const ENDPOINT = 'https://vendedores.mercadolivre.com.br/stock-management/space-management/api/actions';

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function estado(sb, conta, itemId) {
  const { data: t } = await sb.from('ml_tokens').select('access_token').eq('conta', conta).maybeSingle();
  const r = await fetch(
    `https://api.mercadolibre.com/items/${itemId}?attributes=id,status,available_quantity,shipping`,
    { headers: { Authorization: `Bearer ${t.access_token}` } }
  );
  const j = await r.json();
  return { status: j.status, un: j.available_quantity, log: j.shipping?.logistic_type };
}

async function main() {
  const [conta, codigo, itemId] = process.argv.slice(2);
  if (!conta || !codigo || !itemId) throw new Error('uso: node testar-sequencia.js CONTA CODIGO MLB...');
  const sb = conectar();

  const { data: alvo } = await sb.from('ml_patrulha_full')
    .select('user_product_id, titulo').eq('conta', conta.toUpperCase()).eq('codigo_ml', codigo).maybeSingle();
  if (!alvo?.user_product_id) throw new Error('não achei o user_product_id desse código');

  const antes = await estado(sb, conta.toUpperCase(), itemId);
  console.log(`\n  ${codigo} (${alvo.user_product_id})`);
  console.log(`  ANTES:  status=${antes.status}  unidades=${antes.un}  logistica=${antes.log}\n`);

  const navegador = await abrirNavegador(conta.toUpperCase());
  try {
    const pagina = navegador.pages()[0] || (await navegador.newPage());
    await pagina.goto(PAINEL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pagina.waitForFunction(
      () => !!document.querySelector('meta[name*=csrf i], meta[name*=xsrf i]'), { timeout: 45000 }
    ).catch(() => {});
    const csrf = await pagina.evaluate(() => {
      const m = document.querySelector('meta[name*=csrf i], meta[name*=xsrf i]');
      return m ? m.getAttribute('content') : null;
    });
    if (!csrf) throw new Error('não achei o csrf');

    async function chamar(actionId) {
      return pagina.evaluate(async ({ endpoint, csrf, actionId, ids }) => {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
          body: JSON.stringify({ actionId, ids }),
          credentials: 'include',
        });
        let texto = null;
        try { texto = await resp.text(); } catch (_e) { /* nada */ }
        return { status: resp.status, texto };
      }, { endpoint: ENDPOINT, csrf, actionId, ids: [alvo.user_product_id] });
    }

    const v = await chamar('MAKE_SINGLE_OFFER_FULL_VALIDATE');
    console.log(`  1) VALIDATE  → HTTP ${v.status}`);
    await new Promise((r) => setTimeout(r, 1500));

    const a = await chamar('MAKE_OFFER_FULL_ACTION');
    console.log(`  2) ACTION    → HTTP ${a.status}`);
    try {
      const j = JSON.parse(a.texto || '{}');
      if (j.snackbar?.message) console.log(`     "${j.snackbar.message}"`);
    } catch (_e) { /* sem json */ }
  } finally {
    await navegador.close().catch(() => {});
  }

  console.log('\n  esperando 20s pro ML processar...');
  await new Promise((r) => setTimeout(r, 20000));

  const depois = await estado(sb, conta.toUpperCase(), itemId);
  console.log(`\n  DEPOIS: status=${depois.status}  unidades=${depois.un}  logistica=${depois.log}`);
  console.log(depois.log === 'fulfillment'
    ? '\n  >>> VOLTOU PRO FULL — a sequência VALIDATE→ACTION funciona.\n'
    : `\n  >>> NÃO mudou (continua ${depois.log}).\n`);
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
