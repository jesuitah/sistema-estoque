// Confere, anúncio por anúncio no Mercado Livre, se a cópia de campanha realmente valeu.
//
// NÃO confia no "0 recusados" da chamada: pergunta ao ML o estado de cada anúncio e
// compara o percentual real com o que a origem tinha. HTTP 200 já mentiu neste projeto.
//
// Como usar:  node conferir-copia.js KMP AGOSTO SETEMBRO

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

const pctDe = (cheio, preco) => Math.round((1 - Number(preco) / Number(cheio)) * 1000) / 10;

async function carregar(sb, conta) {
  let todos = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await sb.from('ml_promocoes_itens').select('*')
      .eq('conta', conta).order('item_id').range(i, i + 999);
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
  const sb = conectar();

  const { data: tok } = await sb.from('ml_tokens')
    .select('access_token').eq('conta', conta).maybeSingle();
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const linhas = await carregar(sb, conta);
  const origem = linhas.filter((l) => (l.promocao_nome || '').toUpperCase() === nomeOrigem && l.status === 'started');
  const destino = linhas.find((l) => (l.promocao_nome || '').toUpperCase() === nomeDestino);
  const destinoId = destino.promocao_id;

  console.log(`\n  ${conta}: conferindo ${origem.length} anúncios da ${nomeOrigem} no ${nomeDestino}`);
  console.log('  (perguntando ao Mercado Livre um por um, sem usar o cache)\n');

  let certos = 0, fora = 0, diferentes = 0;
  const problemas = [];

  for (let i = 0; i < origem.length; i++) {
    const o = origem[i];
    const esperado = pctDe(o.preco_cheio, o.preco_promo);
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/seller-promotions/items/${o.item_id}?app_version=v2`,
        { headers: auth });
      if (!r.ok) { problemas.push({ o, motivo: `o ML respondeu ${r.status}` }); fora++; continue; }

      const lista = await r.json();
      const noDestino = lista.find((p) => p.id === destinoId && p.status === 'started');
      if (!noDestino) {
        problemas.push({ o, esperado, motivo: `NÃO está na ${nomeDestino}` });
        fora++;
        continue;
      }
      const real = pctDe(noDestino.original_price, noDestino.price);
      // Meio ponto de folga: o preço é arredondado ao centavo, então 8% pode virar 8,0.
      if (Math.abs(real - esperado) > 0.5) {
        problemas.push({ o, esperado, real, motivo: `está com ${real}% em vez de ${esperado}%` });
        diferentes++;
      } else {
        certos++;
      }
    } catch (e) {
      problemas.push({ o, motivo: e.message });
      fora++;
    }

    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${origem.length}...`);
  }

  console.log(`\n  ── resultado ───────────────────────────`);
  console.log(`  certos ................ ${certos}`);
  console.log(`  fora da ${nomeDestino.padEnd(13)} ${fora}`);
  console.log(`  com % diferente ....... ${diferentes}`);
  if (problemas.length) {
    console.log('');
    problemas.slice(0, 30).forEach((p) => {
      console.log(`     ${(p.o.title || p.o.item_id).slice(0, 44).padEnd(46)}${p.motivo}`);
    });
    if (problemas.length > 30) console.log(`     ... e mais ${problemas.length - 30}`);
  }
  console.log('');
  process.exit(problemas.length ? 1 : 0);
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(2); });
