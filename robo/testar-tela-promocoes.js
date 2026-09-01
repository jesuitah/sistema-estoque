// Testa a lógica da tela de Promoções com os dados reais do banco, sem precisar
// abrir o site nem fazer login.
//
// Reproduz exatamente as contas que a tela faz — agrupar por anúncio, escolher a
// vencedora, calcular quanto sobra — e confere se os números fecham.
//
// Como usar:  node testar-tela-promocoes.js KMP

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

const moeda = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

function promocaoRelevante(l) {
  return l.promocao_tipo === 'SELLER_CAMPAIGN'
      || Number(l.meli_percentual) > 0
      || ['SMART', 'UNHEALTHY_STOCK', 'PRICE_MATCHING', 'BANK'].includes(l.promocao_tipo);
}

function quantoSobra(l, preco) {
  if (preco == null || l.tarifa_percentual == null) return null;
  return preco - (preco * Number(l.tarifa_percentual) / 100) - Number(l.tarifa_fixa || 0);
}

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  const sb = conectar();

  // Mesma carga paginada da tela
  let todos = [];
  for (let inicio = 0; ; inicio += 1000) {
    const { data } = await sb.from('ml_promocoes_itens').select('*')
      .eq('conta', conta).order('item_id').range(inicio, inicio + 999);
    if (!data || !data.length) break;
    todos = todos.concat(data);
    if (data.length < 1000) break;
  }
  console.log(`\n  ${conta}: ${todos.length} linhas carregadas`);

  const porAnuncio = {};
  todos.forEach((l) => { (porAnuncio[l.item_id] = porAnuncio[l.item_id] || []).push(l); });
  console.log(`  ${Object.keys(porAnuncio).length} anúncios distintos\n`);

  // Abrindo a SETEMBRO, como o Matheus faria
  const alvo = todos.find((l) => l.promocao_nome === 'SETEMBRO')
            || todos.find((l) => l.promocao_tipo === 'SELLER_CAMPAIGN');
  if (!alvo) { console.log('  sem campanha própria nesta conta'); return; }
  console.log(`  promoção aberta: ${alvo.promocao_nome}\n`);

  const pct = 13;
  let mostrados = 0, semTarifa = 0, comVencedora = 0;

  for (const id of Object.keys(porAnuncio)) {
    const linhas = porAnuncio[id];
    if (!linhas.some((x) => x.promocao_id === alvo.promocao_id)) continue;
    const base = linhas[0];
    const cheio = Number(base.preco_cheio || 0);

    const ativasComPreco = linhas.filter((x) => x.status === 'started' && x.preco_promo);
    let vencedora = null;
    if (ativasComPreco.length > 1) {
      for (const x of ativasComPreco) {
        if (!vencedora || Number(x.preco_promo) < Number(vencedora.preco_promo)) vencedora = x;
      }
      comVencedora++;
    }

    if (mostrados < 2) {
      console.log(`  ${base.title ? base.title.slice(0, 52) : id}`);
      console.log(`     ${base.sku || '(sem sku)'} · ${moeda(cheio)}${base.frete_gratis ? ' · frete grátis' : ''}`);
      for (const l of linhas.filter(promocaoRelevante)) {
        const minha = l.promocao_tipo === 'SELLER_CAMPAIGN';
        let preco = l.preco_promo != null ? Number(l.preco_promo) : null;
        let simulado = false;
        if (preco == null && minha && cheio) {
          preco = Math.round(cheio * (1 - pct / 100) * 100) / 100;
          simulado = true;
        }
        const sobra = quantoSobra(l, preco);
        const banca = Number(l.meli_percentual) > 0 ? cheio * Number(l.meli_percentual) / 100 : null;
        const venceu = vencedora && vencedora.promocao_id === l.promocao_id;
        console.log(
          `       ${l.promocao_nome.slice(0, 26).padEnd(28)}`
          + `${preco != null ? moeda(cheio - preco).padStart(11) : '          —'}`
          + `${preco != null ? moeda(preco).padStart(12) : '           —'}`
          + `${sobra != null ? moeda(sobra).padStart(12) : '           —'}`
          + `${venceu ? '  ATIVA E GANHANDO' : l.status === 'started' ? '  ATIVA' : ''}`
          + `${simulado ? '  (simulado)' : ''}`
          + `${banca ? `\n         └ Reduzimos ${moeda(banca)} das suas tarifas por cada venda` : ''}`
        );
      }
      console.log('');
    }
    if (linhas.some((l) => l.tarifa_percentual == null)) semTarifa++;
    mostrados++;
  }

  console.log(`  ── conferência ──────────────────────────────`);
  console.log(`  anúncios na promoção .............. ${mostrados}`);
  console.log(`  com mais de uma promoção ativa .... ${comVencedora}`);
  console.log(`  SEM tarifa (não calcula o quanto sobra) ... ${semTarifa}`);
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
