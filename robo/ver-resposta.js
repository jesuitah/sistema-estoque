// DIAGNÓSTICO — dispara UMA vez e mostra a resposta COMPLETA do Mercado Livre.
//
// O robô sempre olhou só o código HTTP (200 = "aceitou"). Mas 200 com corpo dizendo
// "faltou confirmar" é exatamente o tipo de coisa que explicaria 31 tentativas sem
// efeito. Aqui lemos o corpo inteiro, que nunca foi examinado.
//
// Dispara a mesma ação que o robô já dispara de hora em hora, uma única vez.
//
// Como usar:  node ver-resposta.js KMP

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

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  const sb = conectar();

  const { data: alvos } = await sb.from('ml_patrulha_full')
    .select('codigo_ml, titulo, user_product_id')
    .eq('conta', conta).is('resolvido_em', null).is('desistiu_em', null).limit(1);

  if (!alvos || !alvos.length) { console.log('\n  Nada pendente nesta conta.\n'); return; }
  const alvo = alvos[0];
  console.log(`\n  ${conta} — disparando UMA vez em ${alvo.codigo_ml} (${alvo.user_product_id})\n`);

  const navegador = await abrirNavegador(conta);
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

    // Testamos as variações de ação que já conhecemos, uma por vez, e mostramos
    // a resposta inteira de cada uma. Nenhuma é repetida.
    const variantes = ['MAKE_OFFER_FULL', 'MAKE_SINGLE_OFFER_FULL_VALIDATE', 'MAKE_OFFER_FULL_ACTION'];

    for (const actionId of variantes) {
      const r = await pagina.evaluate(async ({ endpoint, csrf, actionId, ids }) => {
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

      console.log(`  ── ${actionId} ─────────────────────────────`);
      console.log(`     HTTP ${r.status}`);
      console.log(`     resposta: ${(r.texto || '(vazia)').slice(0, 1200)}`);
      console.log('');
      await new Promise((res) => setTimeout(res, 2000));
    }
  } finally {
    await navegador.close().catch(() => {});
  }
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
