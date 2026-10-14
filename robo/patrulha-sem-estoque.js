// PATRULHA: anúncio ATIVO no Mercado Livre sem a peça no nosso estoque.
//
// REGRA (definida pelo Matheus em 14/10/2026)
//
//   NÃO É FULL  ->  não pode estar ativo sem peça. Tem que PAUSAR.
//   É FULL      ->  pode estar ativo sem peça (a peça está no galpão do ML, não aqui).
//                   O que NÃO pode é o Envios Flex ligado — o Flex sai daqui, e daqui
//                   não tem peça. Tem que DESLIGAR O FLEX.
//
// POR QUE ISSO EXISTE
// Pôr um anúncio pausado numa promoção faz o ML REATIVAR o anúncio. Com a campanha de
// outubro (cerca de mil ativações em três dias) isso encheu as contas de anúncio ativo
// de peça que não existe. A aba de Promoções já foi travada pra não repetir; esta
// patrulha limpa o que já aconteceu e pega o que escapar por qualquer outro caminho.
//
// A FONTE DE VERDADE É A API DO MERCADO LIVRE, NÃO O NOSSO CACHE.
// O cache (ml_anuncios) serve pra escolher quem conferir — barato, uma consulta. Mas
// status, logística e Flex de cada candidato são lidos na API antes de qualquer
// decisão. Em 14/10/2026 uma lista montada só com o cache acusou 234 anúncios do Full
// como "sem peça" e fez o Matheus revisar tudo isso à toa.
//
// Rodar:  node robo/patrulha-sem-estoque.js            (só olha e escreve o relatório)
//         node robo/patrulha-sem-estoque.js --executar (enfileira pausa / desligar flex)

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://pylkufhziohxvwbbaued.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || lerChaveDoSite();
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const EXECUTAR = process.argv.includes('--executar');
const CONTAS = ['KMP', 'ERP', 'LTS'];

function lerChaveDoSite() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/);
  if (m) return m[1];
  throw new Error('não achei a chave do Supabase no index.html');
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Lê a tabela inteira, de mil em mil: o Supabase corta em 1000 por consulta.
async function tudo(tabela, colunas, filtro) {
  const linhas = [];
  for (let de = 0; ; de += 1000) {
    let q = sb.from(tabela).select(colunas).range(de, de + 999);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tabela}: ${error.message}`);
    linhas.push(...data);
    if (data.length < 1000) break;
  }
  return linhas;
}

// "GAUSS: GI8027" -> um componente. "KIT: A: 1 + B: 2" -> dois. Falta um, falta o kit.
function componentes(bruto) {
  if (!bruto) return [];
  const resto = /^\s*KIT\s*:/i.test(bruto) ? bruto.replace(/^\s*KIT\s*:\s*/i, '') : bruto;
  return resto.split('+').map((p) => {
    const t = p.trim();
    const i = t.indexOf(':');
    if (i < 0) return null;
    return { marca: t.slice(0, i).trim().toUpperCase(), sku: t.slice(i + 1).trim().toUpperCase() };
  }).filter(Boolean);
}

// O ML em lotes de 20, com os campos que decidem: status, logística e Flex.
async function lerNoML(ids, accessToken) {
  const achados = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const r = await fetch(
      `https://api.mercadolibre.com/items?ids=${lote.join(',')}`
      + `&attributes=id,title,status,available_quantity,shipping,price`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!r.ok) throw new Error(`o ML respondeu ${r.status} ao ler os anúncios`);
    for (const entrada of await r.json()) {
      if (entrada.code !== 200) continue;
      const b = entrada.body;
      const tags = b.shipping?.tags ?? [];
      achados.set(b.id, {
        id: b.id,
        title: b.title,
        status: b.status,
        anunciadas: b.available_quantity,
        preco: b.price,
        // 'fulfillment' = Full. A peça está no galpão do ML.
        full: b.shipping?.logistic_type === 'fulfillment',
        // self_service_in = Envios Flex LIGADO (é o que o robô usa pra conferir).
        flex: tags.includes('self_service_in'),
      });
    }
    await espera(120);
  }
  return achados;
}

async function enfileirar(conta, tipo, params, criadoPor) {
  // Nada em duplicidade: se já há tarefa pendente ou feita há pouco, não repete.
  const desde = new Date(Date.now() - 12 * 3600e3).toISOString();
  const { data: antigas } = await sb.from('ml_tarefas_robo')
    .select('status, concluido_em').eq('conta', conta).eq('tipo', tipo)
    .contains('params', { item_id: params.item_id }).order('id', { ascending: false }).limit(5);
  const jaCuidado = (antigas || []).some((t) =>
    t.status === 'pendente' || t.status === 'rodando'
    || (t.status === 'feito' && t.concluido_em && t.concluido_em > desde));
  if (jaCuidado) return false;

  const { error } = await sb.from('ml_tarefas_robo')
    .insert({ conta, tipo, status: 'pendente', criado_por: criadoPor, params });
  return !error;
}

(async () => {
  const estoque = await tudo('estoque', 'marca, sku, unidades');
  const saldo = new Map(estoque.map((e) =>
    [(e.marca || '').toUpperCase() + '|' + (e.sku || '').toUpperCase(), e.unidades]));

  const pausar = [];        // não é Full, está ativo, não temos a peça
  const desligarFlex = [];  // é Full, está ativo sem peça aqui, e o Flex está ligado

  for (const conta of CONTAS) {
    const { data: tk } = await sb.from('ml_tokens')
      .select('access_token, expires_at').eq('conta', conta).maybeSingle();
    if (!tk) { console.log(`${conta}: sem token, pulei`); continue; }
    if (new Date(tk.expires_at).getTime() < Date.now()) {
      console.log(`${conta}: token vencido — ele se renova sozinho a cada 5 min, tente de novo`);
      continue;
    }

    const anuncios = await tudo('ml_anuncios', 'item_id, seller_sku_bruto, status',
      (q) => q.eq('conta', conta));

    // Quem CONFERIR: tudo que o cache conhece e cujo SKU aponta peça zerada aqui.
    // Anúncio sem SKU legível fica de fora — não dá pra afirmar nada sobre ele.
    const candidatos = anuncios.filter((a) => {
      const comps = componentes(a.seller_sku_bruto);
      if (!comps.length) return false;
      return comps.some((c) => saldo.get(c.marca + '|' + c.sku) === 0);
    }).map((a) => a.item_id);

    if (!candidatos.length) { console.log(`${conta}: nada a conferir`); continue; }

    const noML = await lerNoML(candidatos, tk.access_token);
    const porId = new Map(anuncios.map((a) => [a.item_id, a]));

    let ativos = 0;
    for (const [id, m] of noML) {
      if (m.status !== 'active') continue;          // só interessa o que está no ar
      ativos++;
      const base = {
        conta, item_id: id, titulo: m.title, anunciadas: m.anunciadas, preco: m.preco,
        sku: porId.get(id)?.seller_sku_bruto ?? null,
        faltando: componentes(porId.get(id)?.seller_sku_bruto)
          .filter((c) => saldo.get(c.marca + '|' + c.sku) === 0)
          .map((c) => c.marca + ': ' + c.sku).join(' + '),
      };
      if (!m.full) pausar.push(base);
      else if (m.flex) desligarFlex.push(base);
    }
    console.log(`${conta}: ${candidatos.length} conferidos no ML · ${ativos} ativos sem peça aqui`);
  }

  console.log(`\nPAUSAR (não é Full):        ${pausar.length}`);
  console.log(`DESLIGAR FLEX (é Full):     ${desligarFlex.length}`);

  const cab = ['acao', 'conta', 'item_id', 'titulo', 'anunciadas', 'preco', 'sku', 'faltando'];
  const linhas = [
    ...pausar.map((x) => ({ ...x, acao: 'pausar' })),
    ...desligarFlex.map((x) => ({ ...x, acao: 'desligar flex' })),
  ].map((l) => cab.map((c) => String(l[c] ?? '').replace(/;/g, ',')).join(';'));
  const destino = path.join(__dirname, '..', 'ativos-sem-estoque.csv');
  fs.writeFileSync(destino, '﻿' + [cab.join(';')].concat(linhas).join('\r\n'), 'utf8');
  console.log(`relatório: ${destino}`);

  if (!EXECUTAR) {
    console.log('\n(só conferi — rode com --executar pra mandar pro robô)');
    return;
  }

  let n = 0;
  for (const x of pausar) {
    if (await enfileirar(x.conta, 'pausar_anuncio',
      { item_id: x.item_id, title: x.titulo, motivo: 'sem a peça: ' + x.faltando },
      'patrulha-sem-estoque')) n++;
  }
  let f = 0;
  for (const x of desligarFlex) {
    if (await enfileirar(x.conta, 'desligar_flex',
      { item_id: x.item_id, title: x.titulo }, 'patrulha-sem-estoque')) f++;
  }
  console.log(`\nenfileiradas: ${n} pausa(s) · ${f} desligar Flex`);
})().catch((e) => { console.error('parou:', e.message); process.exit(1); });
