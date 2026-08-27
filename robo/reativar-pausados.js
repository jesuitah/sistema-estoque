// Reativa os anúncios que já voltaram pro Full mas continuam pausados.
//
// Voltar pro Full não basta: pausado, o anúncio não vende. Este é o último passo
// do ciclo — o que o Matheus quer de fato.
//
// Só mexe em quem preenche as duas condições, conferidas na API oficial:
//   • está no Full (logistic_type = fulfillment)
//   • está pausado
// E confere o resultado depois de agir, um por um.
//
// Como usar:  node reativar-pausados.js            (mostra o que faria)
//             node reativar-pausados.js --executar  (faz)

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const EXECUTAR = process.argv.includes('--executar');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function estado(auth, userId, mlbu) {
  const b = await fetch(
    `https://api.mercadolibre.com/users/${userId}/items/search?user_product_id=${mlbu}`, { headers: auth });
  const ids = (await b.json()).results || [];
  if (!ids.length) return null;
  const r = await fetch(
    `https://api.mercadolibre.com/items/${ids[0]}?attributes=id,title,status,available_quantity,shipping`,
    { headers: auth });
  const it = await r.json();
  return {
    id: it.id, titulo: it.title, status: it.status, un: it.available_quantity,
    noFull: it.shipping?.logistic_type === 'fulfillment',
  };
}

async function main() {
  const sb = conectar();
  console.log(EXECUTAR ? '\n  REATIVANDO\n' : '\n  ENSAIO — nada será alterado\n');

  let feitos = 0, falhas = 0;

  for (const conta of ['KMP', 'ERP', 'LTS']) {
    const { data: tok } = await sb.from('ml_tokens')
      .select('user_id, access_token').eq('conta', conta).maybeSingle();
    if (!tok) continue;
    const auth = { Authorization: `Bearer ${tok.access_token}` };

    const { data: alvos } = await sb.from('ml_patrulha_full')
      .select('codigo_ml, user_product_id').eq('conta', conta);

    for (const a of alvos || []) {
      if (!a.user_product_id) continue;
      const e = await estado(auth, tok.user_id, a.user_product_id);
      if (!e) continue;
      if (!e.noFull || e.status !== 'paused') continue;   // só os do Full e pausados

      console.log(`  ${conta} ${a.codigo_ml}  ${e.id}  ${e.un} un`);
      console.log(`     ${(e.titulo || '').slice(0, 62)}`);

      if (!EXECUTAR) { console.log('     → seria reativado\n'); continue; }

      const r = await fetch(`https://api.mercadolibre.com/items/${e.id}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      const corpo = await r.json().catch(() => ({}));

      if (!r.ok) {
        falhas++;
        console.log(`     ❌ ${r.status} — ${corpo.message || corpo.error || 'sem detalhe'}\n`);
        continue;
      }

      // Confere de verdade, não confia na resposta
      await new Promise((res) => setTimeout(res, 2000));
      const depois = await estado(auth, tok.user_id, a.user_product_id);
      if (depois && depois.status === 'active') {
        feitos++;
        console.log('     ✅ ativo — confirmado pela API\n');
        await sb.from('ml_log_acoes').insert({
          conta, item_id: a.codigo_ml, title: e.titulo, acao: 'reativado', origem: 'robo',
          detalhe: `voltou pro Full e foi reativado (${e.un} un)`,
        }).then(() => {}, () => {});
      } else {
        falhas++;
        console.log(`     ⚠ continua ${depois ? depois.status : '?'}\n`);
      }
    }
  }

  console.log(`  ${EXECUTAR ? 'reativados' : 'seriam reativados'}: ${feitos}${falhas ? ` · falhas: ${falhas}` : ''}\n`);
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
