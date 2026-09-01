// Gera uma PRÉVIA da nova aba de Promoções, com dados reais, sem tocar no sistema.
//
// Serve pro Matheus ver como ficaria antes de eu aplicar. Não altera nada: só lê a API
// e escreve um arquivo HTML.
//
// Como usar:  node previa-promocoes.js

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONTA = 'KMP';
const QUANTOS = 7;

// Promoções que interessam: as que o Matheus criou, e as em que o ML dá algum
// benefício (banca parte do desconto, reduz tarifa, cofinancia).
const MINHAS = ['SELLER_CAMPAIGN'];
const COM_BENEFICIO = ['SMART', 'UNHEALTHY_STOCK', 'PRICE_MATCHING', 'BANK'];

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

const reais = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

// O QUE O MERCADO LIVRE ESTÁ BANCANDO
//
// Decisão do Matheus: usar a mesma frase do painel do ML em todos os casos, seja
// abatimento de tarifa (PRICE_MATCHING) ou coparticipação no desconto (SMART e
// afins). A API entrega os dois no mesmo campo, meli_percentage.
function textoDoBeneficio(p, valor) {
  return `Reduzimos ${reais(valor)} das suas tarifas por cada venda`;
}

async function main() {
  const sb = conectar();
  const { data: tok } = await sb.from('ml_tokens')
    .select('user_id, access_token').eq('conta', CONTA).maybeSingle();
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  // Anúncios que estão na AGOSTO — são os que vão precisar migrar
  const { data: candidatos } = await sb.from('ml_promocoes_itens')
    .select('item_id, title, sku, preco_cheio')
    .eq('conta', CONTA).eq('promocao_nome', 'AGOSTO').eq('status', 'started')
    .limit(QUANTOS * 3);

  const vistos = new Set();
  const linhas = [];

  for (const c of candidatos || []) {
    if (linhas.length >= QUANTOS || vistos.has(c.item_id)) continue;
    vistos.add(c.item_id);

    const it = await (await fetch(
      `https://api.mercadolibre.com/items/${c.item_id}?attributes=id,title,price,category_id,listing_type_id,shipping,available_quantity`,
      { headers: auth })).json();

    const taxa = await (await fetch(
      `https://api.mercadolibre.com/sites/MLB/listing_prices?price=${it.price}`
      + `&listing_type_id=${it.listing_type_id}&category_id=${it.category_id}`,
      { headers: auth })).json();
    const percentualTarifa = taxa.sale_fee_details?.percentage_fee ?? null;
    const taxaFixa = taxa.sale_fee_details?.fixed_fee ?? 0;

    const promos = await (await fetch(
      `https://api.mercadolibre.com/seller-promotions/items/${c.item_id}?app_version=v2`,
      { headers: auth })).json();

    linhas.push({
      id: it.id, titulo: it.title, sku: c.sku, cheio: it.price,
      unidades: it.available_quantity,
      freteGratis: !!it.shipping?.free_shipping,
      percentualTarifa, taxaFixa,
      promos: promos.map((p) => ({
        id: p.id ?? null, tipo: p.type, nome: p.name || p.type,
        status: p.status, preco: p.price || null,
        meli: p.meli_percentage ?? null, vendedor: p.seller_percentage ?? null,
        inicio: p.start_date, fim: p.finish_date,
      })),
    });
  }

  // Quanto sobra: preço menos a tarifa daquele preço.
  function vocreRecebe(preco, l) {
    if (l.percentualTarifa == null) return null;
    return preco - (preco * l.percentualTarifa / 100) - Number(l.taxaFixa || 0);
  }

  function relevante(p) {
    return MINHAS.includes(p.tipo) || COM_BENEFICIO.includes(p.tipo) || (p.meli > 0);
  }

  const blocos = linhas.map((l) => {
    const principais = l.promos.filter(relevante);
    const outras = l.promos.filter((p) => !relevante(p));

    // QUAL PROMOÇÃO O CLIENTE REALMENTE VÊ
    //
    // Um anúncio pode estar em várias ao mesmo tempo, e o Mercado Livre mostra sempre
    // o MENOR preço (comprovado em teste). Sem marcar isso, você olha duas linhas
    // verdes e não sabe qual está valendo.
    // Só marca quando há DISPUTA. Com uma promoção ativa só, dizer que ela está
    // ganhando é redundante — obviamente é a que vale.
    const ativasComPreco = l.promos.filter((p) => p.status === 'started' && p.preco);
    let vencedora = null;
    if (ativasComPreco.length > 1) {
      for (const p of ativasComPreco) {
        if (!vencedora || Number(p.preco) < Number(vencedora.preco)) vencedora = p;
      }
    }

    // Percentual que o Matheus costuma usar. Numa promoção que ele ainda não ativou,
    // mostramos como FICARIA com esse percentual — senão a linha vem toda com "—" e
    // não serve pra decidir nada.
    const PADRAO = 13;

    function linhaPromo(p, escondida) {
      const ativa = p.status === 'started';
      // Preço definido pelo ML (nas que ele banca parte) ou já ativo
      let preco = p.preco || (p.vendedor ? l.cheio * (1 - (p.meli + p.vendedor) / 100) : null);
      let simulado = false;
      if (!preco && MINHAS.includes(p.tipo)) {
        preco = Math.round(l.cheio * (1 - PADRAO / 100) * 100) / 100;
        simulado = true;
      }
      const desc = preco ? Math.round((1 - preco / l.cheio) * 1000) / 10 : null;
      const recebe = preco ? vocreRecebe(preco, l) : null;
      const minha = MINHAS.includes(p.tipo);

      const venceu = vencedora && p === vencedora;
      // Quanto o ML banca, em reais — a porcentagem sozinha não diz o tamanho do
      // benefício, e é isso que pesa na hora de decidir.
      const bancaReais = p.meli > 0 ? (l.cheio * p.meli / 100) : null;

      return `
      <div class="promo ${ativa ? 'ativa' : ''} ${venceu ? 'vencedora' : ''} ${escondida ? 'escondida' : ''}">
        <div class="nome">
          ${p.nome}
          ${venceu ? '<span class="tag vence">ATIVA E GANHANDO</span>'
                   : ativa ? '<span class="tag on">ATIVA</span>' : ''}
        </div>
        <div class="col ${simulado ? 'previsto' : ''}">
          ${desc != null
            ? `${reais(l.cheio - preco)}<div class="pct">(${desc}%)</div>`
            : '—'}
        </div>
        <div class="col ${simulado ? 'previsto' : ''}">${preco ? reais(preco) : '—'}</div>
        <div class="col recebe ${simulado ? 'previsto' : ''}">
          ${recebe ? reais(recebe) : '—'}
          ${p.meli > 0 ? `<div class="banca">${textoDoBeneficio(p, bancaReais)}</div>` : ''}
        </div>
        <div class="col acao">${ativa ? '<a>alterar</a>' : '<button>ativar</button>'}</div>
      </div>`;
    }

    return `
    <div class="anuncio">
      <div class="cabeca">
        <input type="checkbox">
        <div class="dados">
          <div class="titulo">${l.titulo}</div>
          <div class="sku">${l.sku || ''}</div>
        </div>
        <div class="meta">
          <div class="preco">${reais(l.cheio)}</div>
          ${l.freteGratis ? '<div class="frete">frete grátis</div>' : ''}
        </div>
      </div>
      <div class="tabela">
        <div class="cabecalho">
          <div>Promoção</div><div class="col">Desconto</div><div class="col">Preço final</div>
          <div class="col">Você recebe</div><div class="col"></div>
        </div>
        ${principais.map((p) => linhaPromo(p, false)).join('')}
        ${outras.length ? `<div class="mais">▾ ver outras ${outras.length} promoções</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Prévia — Promoções</title>
<style>
  /* Sem isto a borda de 1px soma na altura e os campos ficam desalinhados do botão */
  *{box-sizing:border-box}
  body{background:#0f172a;color:#e2e8f0;font:14px system-ui,sans-serif;margin:0;padding:24px}
  h1{font-size:18px;margin:0 0 18px}
  .lojas{display:flex;gap:8px;margin-bottom:16px}
  .lojas span{padding:7px 16px;border-radius:8px;background:#1e293b;color:#94a3b8;font-weight:700;font-size:13px}
  .lojas .on{background:#2563eb;color:#fff}
  .anuncio{background:#1e293b;border:1px solid #334155;border-radius:10px;margin-bottom:12px;overflow:hidden}
  .cabeca{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-bottom:1px solid #334155}
  .cabeca input{margin-top:3px;width:16px;height:16px;flex-shrink:0}
  .titulo{font-weight:600}
  /* Preço e frete vão pra ponta direita; embaixo do título fica o SKU, que é
     o que o Matheus usa pra reconhecer a peça. */
  .meta{white-space:nowrap;padding-top:2px;text-align:right}
  .preco{color:#94a3b8;font-size:13px;font-weight:600}
  .frete{color:#64748b;font-size:11px;margin-top:2px}
  .dados{flex:1;min-width:0}
  .sku{color:#fbbf24;font-size:12px;font-weight:600;margin-top:3px}
  .tabela{padding:4px 0}
  .cabecalho,.promo{display:grid;grid-template-columns:1fr 100px 110px 165px 100px;align-items:center;gap:8px;padding:9px 14px}
  .cabecalho{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #334155}
  .promo{border-bottom:1px solid #1e293b;font-size:13px}
  .promo.ativa{background:rgba(16,185,129,.08);border-left:3px solid #10b981;padding-left:11px}
  /* A que o comprador realmente vê: destaque mais forte que as outras ativas */
  .promo.vencedora{background:rgba(16,185,129,.18);border-left:3px solid #34d399}
  .tag.vence{background:#047857;color:#a7f3d0;letter-spacing:.3px}
  .col{text-align:right}
  /* Desconto no formato do ML: o valor em reais e, embaixo, o percentual */
  .pct{color:#64748b;font-size:11px;margin-top:1px}
  .recebe{color:#5eead4;font-weight:700}
  /* A coparticipação vem logo abaixo do que sobra, como o ML faz: as duas
     informações se leem juntas na hora de decidir. */
  .banca{color:#34d399;font-weight:600;font-size:10.5px;line-height:1.3;
         margin-top:3px;white-space:normal;text-align:right}
  /* Valor simulado com o percentual padrão — ainda não é o que está valendo */
  .previsto{opacity:.62;font-style:italic}
  .nome{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .tag{font-size:10px;padding:2px 7px;border-radius:20px;font-weight:700}
  .tag.on{background:#065f46;color:#6ee7b7}
  .tag.minha{background:#1e3a8a;color:#93c5fd}
  .tag.ml{background:#78350f;color:#fcd34d}
  .acao button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:5px 12px;font-weight:700;cursor:pointer;font-size:12px}
  .acao a{color:#60a5fa;font-size:12px;cursor:pointer}
  .mais{color:#64748b;font-size:12px;padding:8px 14px;cursor:pointer}
  /* BARRA DE AÇÃO
     Três grupos com pesos diferentes: marcar (leve), buscar (neutro, ocupa o meio)
     e agir (destacado, na ponta). Antes era tudo do mesmo tamanho na mesma linha,
     sem hierarquia — o olho não sabia onde pousar. */
  .barra{display:flex;gap:16px;align-items:center;background:#0b1220;
         border:1px solid #1e293b;border-radius:12px;padding:12px 16px}
  .marcar{display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer;white-space:nowrap}
  .marcar input{width:16px;height:16px}

  .busca{flex:1;display:flex;align-items:center;gap:8px;background:#0f172a;height:38px;
         border:1px solid #1e293b;border-radius:8px;padding:0 12px;min-width:0}
  .busca span{color:#475569;font-size:13px}
  .busca input{flex:1;background:none;border:0;color:#e2e8f0;font-size:13px;outline:none;min-width:0;padding:0}
  .busca input::placeholder{color:#475569}

  .acao{display:flex;align-items:center;gap:10px}
  .campo{display:flex;align-items:center;gap:8px;background:#0f172a;border:1px solid #1e293b;
         border-radius:8px;padding:0 12px;height:38px}
  .campo span{color:#64748b;font-size:12px}
  .campo input{background:none;border:0;color:#e2e8f0;width:38px;text-align:center;
               font-weight:700;font-size:15px;outline:none;padding:0}
  .barra button{background:#059669;color:#fff;border:0;border-radius:8px;height:38px;
                padding:0 20px;font-weight:700;font-size:13px;cursor:pointer}
  .barra button[disabled]{background:#1e293b;color:#475569;cursor:not-allowed}
  .dica{color:#475569;font-size:11.5px;margin:8px 2px 16px}
</style></head><body>
<h1>🏷 Promoções</h1>
<div class="lojas"><span class="on">KMP</span><span>ERP</span><span>LTS</span></div>
<div class="barra">
  <label class="marcar"><input type="checkbox"><span>selecionar todos</span></label>
  <div class="busca"><span>🔎</span><input type="text" placeholder="filtrar por título ou SKU"></div>
  <div class="acao">
    <div class="campo"><span>desconto</span><input type="text" value="13"><span>%</span></div>
    <button disabled>aplicar</button>
  </div>
</div>
<div class="dica">Marque os anúncios, escolha o percentual e aplique. O botão libera quando houver seleção.</div>
${blocos}
</body></html>`;

  const destino = path.join(__dirname, '..', 'previa-promocoes.html');
  fs.writeFileSync(destino, html);
  console.log('  prévia gerada: ' + destino);
  console.log('  ' + linhas.length + ' anúncios reais da ' + CONTA);
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
