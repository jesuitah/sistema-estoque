// Diagnóstico de QUALIDADE dos anúncios — via API oficial do Mercado Livre.
//
// Como usar:   node qualidade.js
//
// Não usa navegador nem sessão: é só leitura pela API com o token OAuth.
// O Mercado Livre dá a cada anúncio uma nota `health` de 0 a 1. Nota 1 = ficha
// completa ("nota máxima"). Abaixo disso, algo está faltando.
//
// Gera robo/prints/qualidade-<CONTA>.csv com a lista pra trabalhar.

const fs = require('fs');
const path = require('path');

// Tokens ficam em robo/.tokens.json, que está no .gitignore — nunca no código,
// nunca no GitHub. Formato: [{ "conta":"KMP", "user_id":"...", "access_token":"..." }]
// Os tokens do Mercado Livre expiram em ~6h; se der erro de autorização, regerar o
// arquivo a partir da tabela `ml_tokens` do Supabase.
const ARQUIVO_TOKENS = path.join(__dirname, '.tokens.json');

async function tokens() {
  if (!fs.existsSync(ARQUIVO_TOKENS)) {
    throw new Error(
      'Falta o arquivo robo/.tokens.json com os tokens das contas.\n' +
      '     Ele é gerado a partir da tabela ml_tokens do Supabase.'
    );
  }
  return JSON.parse(fs.readFileSync(ARQUIVO_TOKENS, 'utf8'));
}

async function todosOsIds(conta) {
  const H = { Authorization: `Bearer ${conta.access_token}` };
  const ids = [];
  let scroll = null;
  for (let i = 0; i < 80; i++) {
    let u = `https://api.mercadolibre.com/users/${conta.user_id}/items/search?search_type=scan&limit=100&status=active`;
    if (scroll) u += `&scroll_id=${encodeURIComponent(scroll)}`;
    const r = await fetch(u, { headers: H });
    const j = await r.json();
    if (!r.ok) { console.log(`  ${conta.conta}: erro na busca — ${JSON.stringify(j).slice(0, 120)}`); break; }
    const res = j.results || [];
    ids.push(...res);
    scroll = j.scroll_id;
    if (!res.length || !scroll) break;
  }
  return ids;
}

async function detalhes(conta, ids) {
  const H = { Authorization: `Bearer ${conta.access_token}` };
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const u = `https://api.mercadolibre.com/items?ids=${lote.join(',')}&attributes=id,title,health,category_id,price,available_quantity,attributes,pictures,permalink`;
    const r = await fetch(u, { headers: H });
    const j = await r.json();
    if (!Array.isArray(j)) continue;
    for (const x of j) if (x.code === 200) out.push(x.body);
    process.stdout.write(`    lidos ${out.length}/${ids.length}\r`);
  }
  return out;
}

function faixa(h) {
  if (h === null || h === undefined) return 'sem nota';
  if (h >= 1) return 'nota máxima (1.00)';
  if (h >= 0.9) return 'muito boa (0.90–0.99)';
  if (h >= 0.8) return 'boa (0.80–0.89)';
  if (h >= 0.7) return 'média (0.70–0.79)';
  if (h >= 0.5) return 'baixa (0.50–0.69)';
  return 'crítica (<0.50)';
}

async function main() {
  const contas = await tokens();
  console.log('');
  console.log('  QUALIDADE DOS ANÚNCIOS (nota do Mercado Livre, 0 a 1)');
  console.log('  ' + '═'.repeat(56));

  const geral = {};
  for (const c of contas) {
    console.log('');
    console.log(`  ${c.conta}`);
    const ids = await todosOsIds(c);
    const itens = await detalhes(c, ids);
    console.log(`    ${itens.length} anúncios ativos analisados.          `);

    const porFaixa = {};
    itens.forEach((i) => { const f = faixa(i.health); porFaixa[f] = (porFaixa[f] || 0) + 1; });
    Object.entries(porFaixa)
      .sort((a, b) => b[1] - a[1])
      .forEach(([f, n]) => console.log(`      ${String(n).padStart(5)}  ${f}`));

    const abaixo = itens.filter((i) => typeof i.health === 'number' && i.health < 1);
    const media = itens.filter((i) => typeof i.health === 'number');
    const notaMedia = media.length ? (media.reduce((s, i) => s + i.health, 0) / media.length) : 0;
    console.log(`      nota média: ${notaMedia.toFixed(3)}  |  abaixo do máximo: ${abaixo.length}`);

    geral[c.conta] = { total: itens.length, abaixo: abaixo.length, notaMedia };

    // csv pra trabalhar, do pior pro melhor
    abaixo.sort((a, b) => (a.health || 0) - (b.health || 0));
    const linhas = ['nota;item_id;titulo;fotos;atributos;preco;estoque;link'].concat(
      abaixo.map((i) => [
        (i.health ?? '').toString().replace('.', ','),
        i.id,
        `"${String(i.title || '').replace(/"/g, '""')}"`,
        (i.pictures || []).length,
        (i.attributes || []).length,
        String(i.price ?? '').replace('.', ','),
        i.available_quantity ?? '',
        i.permalink || '',
      ].join(';'))
    );
    fs.writeFileSync(path.join(__dirname, 'prints', `qualidade-${c.conta}.csv`), '﻿' + linhas.join('\n'), 'utf8');
    fs.writeFileSync(path.join(__dirname, 'prints', `qualidade-${c.conta}.json`), JSON.stringify(abaixo, null, 1));
  }

  console.log('');
  console.log('  ' + '═'.repeat(56));
  const t = Object.values(geral).reduce((s, g) => s + g.total, 0);
  const a = Object.values(geral).reduce((s, g) => s + g.abaixo, 0);
  console.log(`  TOTAL: ${t} anúncios ativos · ${a} abaixo da nota máxima`);
  console.log('  Listas em robo/prints/qualidade-<CONTA>.csv');
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
