// Descobre quanto o Matheus pagou de frete em cada venda e guarda em ml_fretes.
//
// POR QUE PRECISA GUARDAR
// O custo do frete não vem no pedido: é uma chamada por envio. São ~2.750 envios, o
// que leva uns 20 minutos. Guardado, a tela lê na hora — e nas próximas vezes só busca
// o que chegou de novo.
//
// O QUE É O VALOR
// senders[0].cost, que já é o LÍQUIDO: o desconto do ML está abatido. Num caso real,
// R$ 9,79 de frete com R$ 2,94 de desconto viraram R$ 6,85 pagos.
//
// RATEIO: o frete é do ENVIO, não do item. Pedido com 2 itens diferentes num pacote só
// tem um frete — dividimos entre eles, senão o custo apareceria dobrado.
//
// Como usar:  node coletar-fretes.js            (todas, só o que falta)
//             node coletar-fretes.js KMP        (uma conta)
//             node coletar-fretes.js KMP --tudo (refaz do zero)

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONTAS = ['KMP', 'ERP', 'LTS'];

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function buscar(url, opcoes = {}, segundos = 20) {
  const abortar = new AbortController();
  const relogio = setTimeout(() => abortar.abort(), segundos * 1000);
  try {
    return await fetch(url, { ...opcoes, signal: abortar.signal });
  } finally {
    clearTimeout(relogio);
  }
}

async function pedidosDaConta(sb, conta) {
  let todos = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await sb.from('ml_pedidos')
      .select('ml_order_id, shipping_id, itens, logistic_type, is_full, data_criacao_ml')
      .eq('conta', conta).not('shipping_id', 'is', null)
      .order('data_criacao_ml', { ascending: false }).range(i, i + 999);
    if (!data || !data.length) break;
    todos = todos.concat(data);
    if (data.length < 1000) break;
  }
  return todos;
}

async function jaColetados(sb, conta) {
  const vistos = new Set();
  for (let i = 0; ; i += 1000) {
    const { data } = await sb.from('ml_fretes')
      .select('ml_order_id').eq('conta', conta).range(i, i + 999);
    if (!data || !data.length) break;
    data.forEach((x) => vistos.add(String(x.ml_order_id)));
    if (data.length < 1000) break;
  }
  return vistos;
}

async function coletarConta(sb, conta, { tudo = false, log = console.log } = {}) {
  // Falha de consulta NÃO é o mesmo que conta sem token.
  //
  // Antes os dois casos caíam no mesmo "sem token, pulando". A KMP foi pulada uma vez
  // por um tropeço de rede, com o token intacto no banco, e a mensagem dizia o
  // contrário — mandando procurar o problema no lugar errado. Erro de consulta agora
  // interrompe em vez de fingir que a conta não existe.
  const { data: tok, error: erroTok } = await sb.from('ml_tokens')
    .select('access_token').eq('conta', conta).maybeSingle();
  if (erroTok) throw new Error(`não consegui ler o token: ${erroTok.message}`);
  if (!tok) { log(`  ${conta}: sem token cadastrado, pulando`); return null; }
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const pedidos = await pedidosDaConta(sb, conta);
  const vistos = tudo ? new Set() : await jaColetados(sb, conta);
  const faltam = pedidos.filter((p) => !vistos.has(String(p.ml_order_id)));

  log(`  ${conta}: ${pedidos.length} envios · ${faltam.length} a buscar`);
  if (!faltam.length) return { conta, novos: 0 };

  const linhas = [];
  let erros = 0;

  for (let i = 0; i < faltam.length; i++) {
    const p = faltam[i];
    const itens = (Array.isArray(p.itens) ? p.itens : [])
      .map((x) => x && x.item && x.item.id)
      .filter(Boolean);
    if (!itens.length) continue;

    try {
      const r = await buscar(`https://api.mercadolibre.com/shipments/${p.shipping_id}/costs`, { headers: auth });
      if (!r.ok) { erros++; continue; }
      const c = await r.json();
      const s = (c.senders || [])[0] || {};

      const pago = s.cost != null ? Number(s.cost) : null;
      const desconto = s.save != null ? Number(s.save)
        : (s.discounts || []).reduce((soma, d) => soma + Number(d.promoted_amount || 0), 0) || null;

      // Um frete por envio: divide entre os itens do pacote.
      const porItem = pago != null ? Math.round((pago / itens.length) * 100) / 100 : null;

      // Um pedido pode repetir o mesmo anúncio; a chave é (pedido, item).
      for (const itemId of [...new Set(itens)]) {
        linhas.push({
          conta, ml_order_id: p.ml_order_id, shipping_id: p.shipping_id, item_id: itemId,
          custo: porItem,
          custo_bruto: pago != null && desconto != null ? Math.round((pago + desconto) * 100) / 100 : pago,
          desconto_ml: desconto,
          itens_no_envio: itens.length,
          logistic_type: p.logistic_type, is_full: p.is_full,
          vendido_em: p.data_criacao_ml,
        });
      }
    } catch (_e) { erros++; }

    if ((i + 1) % 200 === 0) log(`  ${conta}: ${i + 1}/${faltam.length}`);
  }

  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await sb.from('ml_fretes')
      .upsert(linhas.slice(i, i + 500), { onConflict: 'ml_order_id,item_id' });
    if (error) throw new Error(`falha ao gravar: ${error.message}`);
  }

  log(`  ${conta}: ${linhas.length} fretes gravados${erros ? ` · ${erros} envios não responderam` : ''}`);
  return { conta, novos: linhas.length, erros };
}

async function coletar({ contas = CONTAS, tudo = false, log = console.log } = {}) {
  const sb = conectar();
  const saida = [];
  for (const conta of contas) {
    const r = await coletarConta(sb, conta, { tudo, log }).catch((e) => {
      log(`  ${conta}: falhou — ${e.message}`);
      return null;
    });
    if (r) saida.push(r);
  }
  return saida;
}

module.exports = { coletar, CONTAS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const tudo = args.includes('--tudo');
  const conta = args.find((a) => !a.startsWith('--'));
  coletar({ contas: conta ? [conta.toUpperCase()] : CONTAS, tudo })
    .then((r) => console.log('\n  ' + JSON.stringify(r) + '\n'))
    .catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
}
