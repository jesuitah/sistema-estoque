// Acha e destrava os anúncios presos no Full SEM estoque.
//
// Situação que isto resolve: o anúncio ficou sem unidade, deveria sair do Full e ir
// pra Inativos, mas está parado no Full com 0 unidades — sem vender.
//
// Não faz nada direto no Mercado Livre: enfileira a tarefa "tirar do Full" na fila
// que o robô já usa, do mesmo jeito que o botão do site faz. Assim passa pelas
// mesmas verificações e pelo mesmo registro de histórico.
//
// Como usar:  node destravar-full.js             (mostra o que faria)
//             node destravar-full.js --executar   (enfileira)

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const EXECUTAR = process.argv.includes('--executar');
const CONTAS = ['KMP', 'ERP', 'LTS'];

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function idsPorStatus(userId, status, auth) {
  const ids = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const r = await fetch(
      `https://api.mercadolibre.com/users/${userId}/items/search?status=${status}&limit=100&offset=${offset}`,
      { headers: auth });
    if (!r.ok) break;
    const j = await r.json();
    const lote = j.results || [];
    ids.push(...lote);
    if (lote.length < 100) break;
  }
  return ids;
}

async function detalhes(ids, auth) {
  const saida = [];
  for (let i = 0; i < ids.length; i += 20) {
    const r = await fetch(
      `https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(',')}`
      + `&attributes=id,title,status,sub_status,available_quantity,shipping,seller_custom_field`,
      { headers: auth });
    if (!r.ok) continue;
    for (const x of await r.json()) if (x.code === 200 && x.body) saida.push(x.body);
  }
  return saida;
}

async function main() {
  const sb = conectar();
  console.log(EXECUTAR ? '\n  DESTRAVANDO\n' : '\n  VARREDURA — nada será alterado\n');

  let total = 0;

  for (const conta of CONTAS) {
    const { data: tok } = await sb.from('ml_tokens')
      .select('user_id, access_token').eq('conta', conta).maybeSingle();
    if (!tok) continue;
    const auth = { Authorization: `Bearer ${tok.access_token}` };

    let itens = [];
    for (const st of ['paused', 'active']) {
      itens = itens.concat(await detalhes(await idsPorStatus(tok.user_id, st, auth), auth));
    }

    // Preso no Full: está no Full e não tem nenhuma unidade pra vender.
    const presos = itens.filter((it) =>
      it.shipping?.logistic_type === 'fulfillment' && it.available_quantity === 0);

    console.log(`  ${conta}: ${itens.length} anúncios conferidos · ${presos.length} presos no Full sem estoque`);

    for (const it of presos) {
      console.log(`     ${it.id}  ${(it.title || '').slice(0, 55)}`);
      total++;
      if (!EXECUTAR) continue;

      // Já tem tarefa esperando pra este anúncio? Não duplica.
      const { data: jaTem } = await sb.from('ml_tarefas_robo')
        .select('id').eq('conta', conta).eq('tipo', 'tirar_do_full')
        .in('status', ['pendente', 'rodando'])
        .contains('params', { item_id: it.id }).limit(1);
      if (jaTem && jaTem.length) { console.log('        (já está na fila)'); continue; }

      await sb.from('ml_tarefas_robo').insert({
        conta, tipo: 'tirar_do_full', status: 'pendente',
        params: {
          item_id: it.id,
          title: it.title,
          sku_bruto: it.seller_custom_field || null,
          // Sem unidade nenhuma, o destino é Inativos — é a regra do sistema.
          acao_depois: 'inativar',
        },
      });
      console.log('        → enfileirado');
    }
  }

  console.log(`\n  ${EXECUTAR ? 'enfileirados' : 'seriam enfileirados'}: ${total}\n`);
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
