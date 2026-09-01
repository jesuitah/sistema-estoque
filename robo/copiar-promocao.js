// Copia uma campanha inteira para outra, PRESERVANDO o percentual de cada anúncio.
//
// POR QUE ISTO EXISTE
// A AGOSTO da KMP tem 414 anúncios espalhados por ~30 percentuais diferentes. Um por
// um seria um dia de trabalho, e aplicar uma % única a todos jogaria fora a decisão de
// preço que já estava tomada em cada um.
//
// SEGURO POR PADRÃO: sem --aplicar ele só mostra o que faria.
//
// Como usar:
//   node copiar-promocao.js KMP AGOSTO SETEMBRO            (prévia)
//   node copiar-promocao.js KMP AGOSTO SETEMBRO --aplicar  (faz)
//
//   --pular-reducoes   não mexe em quem já está no destino com desconto MAIOR do que a
//                      origem daria. Reduzir desconto obriga a sair da promoção e
//                      entrar de novo; se a volta falhar, o anúncio fica sem promoção
//                      nenhuma. Quando o que já está lá é bom, não vale o risco.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const URL_BASE = 'https://pylkufhziohxvwbbaued.supabase.co';

function chaveDoSite() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  return html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
}

const moeda = (v) => v == null ? '—' : 'R$ ' + Number(v).toFixed(2).replace('.', ',');
const pctDe = (cheio, preco) => Math.round((1 - Number(preco) / Number(cheio)) * 1000) / 10;

async function carregarTudo(sb, conta) {
  let todos = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from('ml_promocoes_itens').select('*')
      .eq('conta', conta).order('item_id').range(i, i + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    todos = todos.concat(data);
    if (data.length < 1000) break;
  }
  return todos;
}

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  const nomeOrigem = (process.argv[3] || 'AGOSTO').toUpperCase();
  const nomeDestino = (process.argv[4] || 'SETEMBRO').toUpperCase();
  const aplicar = process.argv.includes('--aplicar');
  const pularReducoes = process.argv.includes('--pular-reducoes');

  const chave = chaveDoSite();
  const sb = createClient(URL_BASE, chave);
  const linhas = await carregarTudo(sb, conta);

  const daOrigem = linhas.filter((l) => (l.promocao_nome || '').toUpperCase() === nomeOrigem);
  const doDestino = linhas.filter((l) => (l.promocao_nome || '').toUpperCase() === nomeDestino);
  if (!daOrigem.length) throw new Error(`não achei a promoção ${nomeOrigem} na ${conta}`);
  if (!doDestino.length) throw new Error(`não achei a promoção ${nomeDestino} na ${conta} — precisa criá-la primeiro no Mercado Livre`);

  const destinoId = doDestino[0].promocao_id;
  const destinoTipo = doDestino[0].promocao_tipo;
  const aceitaDestino = new Map(doDestino.map((l) => [l.item_id, l]));

  console.log(`\n  ${conta}: copiando ${nomeOrigem} → ${nomeDestino}`);
  console.log(`  ${daOrigem.filter((l) => l.status === 'started').length} ativos na origem\n`);

  // Monta o plano: cada anúncio ativo na origem, com o percentual DELE.
  const plano = [];
  const foraDoDestino = [];
  const pulados = [];
  for (const o of daOrigem) {
    if (o.status !== 'started') continue;
    if (!o.preco_cheio || !o.preco_promo) continue;

    const alvo = aceitaDestino.get(o.item_id);
    if (!alvo) { foraDoDestino.push(o); continue; }   // o destino não aceita este anúncio

    const pct = pctDe(o.preco_cheio, o.preco_promo);
    const jaEsta = alvo.status === 'started';
    const pctAtual = jaEsta && alvo.preco_promo ? pctDe(alvo.preco_cheio, alvo.preco_promo) : null;
    if (jaEsta && pctAtual === pct) continue;   // já está certo, não mexe
    if (pularReducoes && jaEsta && pctAtual > pct) { pulados.push({ item_id: o.item_id, title: o.title, pctAtual, pct }); continue; }

    plano.push({
      item_id: o.item_id, title: o.title, sku: o.sku,
      cheio: Number(o.preco_cheio), pct, jaEsta, pctAtual,
    });
  }

  // Agrupa por percentual: a função aceita uma lista de anúncios por chamada, então
  // 414 anúncios em ~30 percentuais viram ~30 chamadas em vez de 414.
  const porPct = {};
  plano.forEach((p) => { (porPct[p.pct] = porPct[p.pct] || []).push(p); });
  const percentuais = Object.keys(porPct).map(Number).sort((a, b) => a - b);

  console.log('  ── o que vai acontecer ──────────────────────────');
  for (const pct of percentuais) {
    const grupo = porPct[pct];
    const novos = grupo.filter((p) => !p.jaEsta).length;
    const mudam = grupo.length - novos;
    console.log(`  ${String(pct).padStart(5)}%  ${String(grupo.length).padStart(4)} anúncio(s)`
      + `${novos ? ` · ${novos} entram` : ''}${mudam ? ` · ${mudam} mudam de %` : ''}`);
  }
  console.log(`  ${''.padStart(5)}   ${String(plano.length).padStart(4)} no total\n`);

  const mudando = plano.filter((p) => p.jaEsta);
  if (mudando.length) {
    console.log(`  ⚠ ${mudando.length} já estão na ${nomeDestino} e vão TROCAR de percentual:`);
    mudando.forEach((p) => {
      console.log(`     ${(p.title || p.item_id).slice(0, 44).padEnd(46)}`
        + `${p.pctAtual}% → ${p.pct}%   ${moeda(p.cheio * (1 - p.pct / 100))}`);
    });
    console.log('');
  }

  if (pulados.length) {
    console.log(`  ${pulados.length} pulado(s) — já estão na ${nomeDestino} com desconto maior, ficam como estão:`);
    pulados.forEach((p) => {
      console.log(`     ${(p.title || p.item_id).slice(0, 44).padEnd(46)}fica com ${p.pctAtual}% (a ${nomeOrigem} daria ${p.pct}%)`);
    });
    console.log('');
  }

  if (foraDoDestino.length) {
    console.log(`  ${foraDoDestino.length} anúncio(s) da ${nomeOrigem} não são aceitos na ${nomeDestino} — ficam de fora.\n`);
  }

  if (!aplicar) {
    console.log('  Isto foi só a prévia. Para fazer de verdade:');
    console.log(`     node copiar-promocao.js ${conta} ${nomeOrigem} ${nomeDestino} --aplicar\n`);
    return;
  }

  // ── APLICANDO ──────────────────────────────────────────────────────────────
  console.log('  ── aplicando ────────────────────────────────────');
  let ok = 0;
  const recusados = [];

  for (const pct of percentuais) {
    const grupo = porPct[pct];
    // Lotes pequenos: cada anúncio é pelo menos uma chamada ao ML lá dentro, e os que
    // reduzem desconto são três. Um lote grande demais estoura o tempo da função.
    for (let i = 0; i < grupo.length; i += 25) {
      const lote = grupo.slice(i, i + 25);
      const r = await fetch(`${URL_BASE}/functions/v1/ml-promocoes?acao=ativar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: chave, Authorization: `Bearer ${chave}` },
        body: JSON.stringify({
          conta, promocao_id: destinoId, promocao_tipo: destinoTipo,
          percentual: pct, itens: lote.map((p) => p.item_id),
        }),
      }).catch((e) => ({ ok: false, erro: e.message }));

      if (!r || !r.ok) {
        lote.forEach((p) => recusados.push({ ...p, motivo: 'a chamada falhou' }));
        console.log(`  ${pct}%: lote de ${lote.length} falhou`);
        continue;
      }
      const d = await r.json();
      ok += (d.ativados || []).length;
      (d.recusados || []).forEach((x) => recusados.push({
        item_id: x.item_id, title: x.title, pct, motivo: x.motivo,
      }));
      console.log(`  ${String(pct).padStart(5)}%  ${(d.ativados || []).length} ok`
        + `${(d.recusados || []).length ? ` · ${(d.recusados || []).length} recusados` : ''}`);
    }
  }

  console.log(`\n  ── resultado ────────────────────────────────────`);
  console.log(`  entraram/alterados ... ${ok}`);
  console.log(`  recusados ............ ${recusados.length}`);
  if (recusados.length) {
    console.log('');
    recusados.slice(0, 40).forEach((x) => {
      console.log(`     ${(x.title || x.item_id).slice(0, 42).padEnd(44)}${x.pct}% — ${x.motivo}`);
    });
    if (recusados.length > 40) console.log(`     ... e mais ${recusados.length - 40}`);
  }
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
