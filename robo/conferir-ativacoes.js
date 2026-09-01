// Confere, direto no Mercado Livre, quais anúncios estão HOJE numa campanha própria —
// e compara com o que o cache da tela dizia.
//
// Serve pra responder "o botão aplicar funcionou de verdade?" sem confiar na mensagem
// de sucesso da tela, que já mentiu antes (HTTP 200 sem nada ter acontecido).
//
// Como usar:  node conferir-ativacoes.js KMP SETEMBRO

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
  const nomeAlvo = (process.argv[3] || 'SETEMBRO').toUpperCase();
  const sb = conectar();

  const { data: tok } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', conta).maybeSingle();
  if (!tok) throw new Error('sem token da ' + conta);
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  // O cache da tela: como estava na última varredura.
  let cache = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await sb.from('ml_promocoes_itens').select('*')
      .eq('conta', conta).order('item_id').range(i, i + 999);
    if (!data || !data.length) break;
    cache = cache.concat(data);
    if (data.length < 1000) break;
  }
  const daPromo = cache.filter((l) => (l.promocao_nome || '').toUpperCase() === nomeAlvo);
  if (!daPromo.length) throw new Error(`não achei a promoção ${nomeAlvo} na ${conta}`);
  const promocaoId = daPromo[0].promocao_id;
  console.log(`\n  ${conta} · ${nomeAlvo} (${promocaoId})`);
  console.log(`  cache: ${daPromo.length} anúncios elegíveis, `
    + `${daPromo.filter((l) => l.status === 'started').length} ativos na última varredura\n`);

  // A verdade: quem o ML diz que está na campanha agora.
  const agora = new Map();
  for (let offset = 0; offset < 5000; offset += 50) {
    const r = await fetch(
      `https://api.mercadolibre.com/seller-promotions/promotions/${promocaoId}/items`
      + `?app_version=v2&promotion_type=SELLER_CAMPAIGN&status=started&limit=50&offset=${offset}`,
      { headers: auth });
    if (!r.ok) { console.log('  (a API recusou a lista: ' + r.status + ')'); break; }
    const j = await r.json();
    const lote = j.results || [];
    for (const it of lote) agora.set(it.id, it);
    if (lote.length < 50) break;
  }
  console.log(`  no Mercado Livre agora: ${agora.size} anúncios ativos nesta campanha\n`);

  const antes = new Set(daPromo.filter((l) => l.status === 'started').map((l) => l.item_id));
  const novos = [...agora.keys()].filter((id) => !antes.has(id));
  const sumiram = [...antes].filter((id) => !agora.has(id));

  const titulo = {};
  daPromo.forEach((l) => { titulo[l.item_id] = l.title; });

  if (novos.length) {
    console.log(`  ✅ ENTRARAM depois da varredura (${novos.length}):`);
    for (const id of novos) {
      const it = agora.get(id);
      const cheio = it.original_price ?? null;
      const promo = it.price ?? null;
      const pct = (cheio && promo) ? Math.round((1 - promo / cheio) * 1000) / 10 : null;
      console.log(`     ${id}  ${(titulo[id] || '').slice(0, 46)}`);
      console.log(`        ${moeda(cheio)} → ${moeda(promo)}${pct != null ? `  (${pct}% off)` : ''}`);
    }
    console.log('');
  } else {
    console.log('  nenhum anúncio novo entrou desde a última varredura\n');
  }

  if (sumiram.length) {
    console.log(`  ⚠ estavam no cache como ativos e o ML não lista mais (${sumiram.length}):`);
    sumiram.slice(0, 10).forEach((id) => console.log(`     ${id}  ${(titulo[id] || '').slice(0, 46)}`));
    console.log('');
  }

  // Prova final: o cliente está mesmo vendo o preço com desconto?
  const amostra = (novos.length ? novos : [...agora.keys()]).slice(0, 3);
  if (amostra.length) {
    console.log('  ── o que o cliente vê na página do anúncio ──');
    for (const id of amostra) {
      const r = await fetch(`https://api.mercadolibre.com/items/${id}/prices`, { headers: auth });
      if (!r.ok) { console.log(`     ${id}: não consegui ler (${r.status})`); continue; }
      const j = await r.json();
      const std = (j.prices || []).find((p) => p.type === 'standard');
      const promo = (j.prices || []).find((p) => p.type === 'promotion');
      console.log(`     ${id}  cheio ${moeda(std?.amount)} · vendendo por ${moeda(promo?.amount ?? std?.amount)}`);
    }
    console.log('');
  }
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
