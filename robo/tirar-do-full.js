// Tira anúncios do programa Full — a ação que hoje é feita na mão.
//
// Como usar:
//    node tirar-do-full.js                 → ENSAIO: mostra o que faria, não faz nada
//    node tirar-do-full.js --executar      → executa de verdade
//    node tirar-do-full.js --executar --limite 1   → executa só o primeiro
//
// Por padrão NÃO EXECUTA. É preciso pedir explicitamente com --executar.
//
// COMO FUNCIONA
// Reproduz exatamente a chamada que o painel do Mercado Livre faz quando alguém
// clica em "Deixar de oferecer Full" (capturada com robo/gravar.js em 2026-08-24):
//
//    POST /stock-management/space-management/api/actions
//      1º {"actionId":"MAKE_NO_OFFER_FULL_VALIDATE","ids":["MLBU..."]}
//      2º {"actionId":"MAKE_NO_OFFER_FULL_ACTION","ids":["MLBU..."]}
//
// Não imita cliques: dispara a mesma requisição, de dentro da própria página (mesma
// origem, mesmos cabeçalhos). Por isso não quebra se o layout mudar.
//
// TRAVAS DE SEGURANÇA
//   • ensaio por padrão
//   • um anúncio por vez, com pausa entre eles
//   • antes: confirma pela API oficial que o anúncio REALMENTE está no Full
//   • depois: confirma pela API oficial que saiu — não acredita na própria ação
//   • qualquer resposta fora do esperado interrompe tudo na hora

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste, identificarConta } = require('./navegador');

const PAINEL = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';
const ENDPOINT = 'https://vendedores.mercadolivre.com.br/stock-management/space-management/api/actions';
const FUNCAO_PENDENTES = 'https://pylkufhziohxvwbbaued.supabase.co/functions/v1/ml-reativar-anuncios';
const PAUSA_ENTRE_ACOES = 4000;

function tokens() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '.tokens.json'), 'utf8'));
}

// Estado do anúncio pela API OFICIAL — é a nossa fonte de verdade, não a tela.
async function estadoDoAnuncio(itemId, accessToken) {
  const r = await fetch(
    `https://api.mercadolibre.com/items/${itemId}?attributes=id,title,status,shipping,user_product_id`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!r.ok) return { erro: `API respondeu ${r.status}` };
  const i = await r.json();
  return {
    titulo: i.title,
    status: i.status,
    logistic_type: i.shipping?.logistic_type ?? null,
    no_full: i.shipping?.logistic_type === 'fulfillment',
    user_product_id: i.user_product_id ?? null,
  };
}

// Dispara a chamada de dentro da página — mesma origem e mesmos cabeçalhos do painel.
async function chamarAcao(pagina, csrf, actionId, userProductId) {
  return pagina.evaluate(async ({ endpoint, csrf, actionId, id }) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
      body: JSON.stringify({ actionId, ids: [id] }),
      credentials: 'include',
    });
    let corpo = null;
    try { corpo = await r.json(); } catch (_e) { corpo = null; }
    return { status: r.status, corpo };
  }, { endpoint: ENDPOINT, csrf, actionId, id: userProductId });
}

async function lerCsrf(pagina) {
  return pagina.evaluate(() => {
    const m = document.querySelector('meta[name*=csrf i], meta[name*=xsrf i]');
    return m ? m.getAttribute('content') : null;
  });
}

async function pendentesDaConta(conta) {
  const r = await fetch(FUNCAO_PENDENTES);
  const j = await r.json();
  const lista = j?.[conta]?.precisa_acao_manual_full;
  return Array.isArray(lista) ? lista : [];
}

async function main() {
  const args = process.argv.slice(2);
  const executar = args.includes('--executar');
  const conta = validarConta(args.find((a) => /^(KMP|ERP|LTS)$/i.test(a)) || 'KMP');
  const iLimite = args.indexOf('--limite');
  const limite = iLimite !== -1 ? parseInt(args[iLimite + 1], 10) : Infinity;

  if (!sessaoExiste(conta)) throw new Error(`Sem sessão salva para ${conta}. Rode: npm run login -- ${conta}`);

  const contas = tokens();
  const cred = contas.find((c) => c.conta === conta);
  if (!cred) throw new Error(`Sem token da conta ${conta} em .tokens.json`);

  console.log('');
  console.log(`  TIRAR DO FULL — conta ${conta}`);
  console.log(`  modo: ${executar ? '*** EXECUÇÃO REAL ***' : 'ENSAIO (não altera nada)'}`);
  console.log('  ' + '═'.repeat(56));

  const pendentes = (await pendentesDaConta(conta)).slice(0, limite);
  if (!pendentes.length) {
    console.log('');
    console.log('  Nenhum anúncio pendente de ação manual. Nada a fazer. ✅');
    console.log('');
    return;
  }
  console.log(`  ${pendentes.length} anúncio(s) na fila.`);

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());
  const quem = await identificarConta(navegador);
  console.log(`  sessão: ${quem.apelido} (${quem.userId})`);

  await pagina.goto(PAINEL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pagina.waitForFunction(() => /C[óo]digo ML/i.test(document.body.innerText || ''), { timeout: 45000 }).catch(() => {});

  const csrf = await lerCsrf(pagina);
  if (!csrf) throw new Error('Não achei o x-csrf-token na página. Interrompendo — não vou chutar.');
  console.log(`  csrf obtido: ${csrf.slice(0, 12)}...`);
  console.log('');

  const resultado = { ok: [], pulados: [], falhas: [] };

  for (const [n, item] of pendentes.entries()) {
    const rotulo = `[${n + 1}/${pendentes.length}] ${item.item_id}`;
    const antes = await estadoDoAnuncio(item.item_id, cred.access_token);

    if (antes.erro) {
      console.log(`  ${rotulo} ⚠ não consegui ler pela API oficial (${antes.erro}) — pulando`);
      resultado.pulados.push({ item: item.item_id, motivo: antes.erro });
      continue;
    }
    console.log(`  ${rotulo} ${String(antes.titulo).slice(0, 52)}`);
    console.log(`        estado atual: ${antes.status} · ${antes.logistic_type}`);

    if (!antes.no_full) {
      console.log('        já não está no Full — pulando');
      resultado.pulados.push({ item: item.item_id, motivo: 'já fora do Full' });
      continue;
    }
    if (!antes.user_product_id) {
      console.log('        sem user_product_id — pulando (a chamada exige esse id)');
      resultado.pulados.push({ item: item.item_id, motivo: 'sem user_product_id' });
      continue;
    }

    if (!executar) {
      console.log(`        [ensaio] tiraria do Full usando ${antes.user_product_id}`);
      resultado.ok.push({ item: item.item_id, ensaio: true });
      continue;
    }

    // 1) valida
    const v = await chamarAcao(pagina, csrf, 'MAKE_NO_OFFER_FULL_VALIDATE', antes.user_product_id);
    if (v.status !== 200) {
      console.log(`        ❌ validação falhou (HTTP ${v.status}) — INTERROMPENDO`);
      resultado.falhas.push({ item: item.item_id, etapa: 'validar', status: v.status, corpo: v.corpo });
      break;
    }

    // 2) executa
    const a = await chamarAcao(pagina, csrf, 'MAKE_NO_OFFER_FULL_ACTION', antes.user_product_id);
    if (a.status !== 200) {
      console.log(`        ❌ ação falhou (HTTP ${a.status}) — INTERROMPENDO`);
      resultado.falhas.push({ item: item.item_id, etapa: 'acao', status: a.status, corpo: a.corpo });
      break;
    }
    const aviso = a.corpo?.snackbar?.message || '(sem mensagem)';
    console.log(`        painel respondeu: ${String(aviso).slice(0, 70)}`);

    // 3) confirma pela API oficial — não acreditamos na própria ação
    await new Promise((r) => setTimeout(r, 6000));
    const depois = await estadoDoAnuncio(item.item_id, cred.access_token);
    if (depois.no_full) {
      console.log('        ⚠ a API oficial ainda mostra no Full — pode demorar a propagar. Registrando pra conferir.');
      resultado.pulados.push({ item: item.item_id, motivo: 'ação aceita, mas ainda não refletiu' });
    } else {
      console.log(`        ✅ confirmado: saiu do Full (${antes.logistic_type} → ${depois.logistic_type})`);
      resultado.ok.push({ item: item.item_id, de: antes.logistic_type, para: depois.logistic_type });
    }

    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ACOES));
  }

  await navegador.close().catch(() => {});

  console.log('');
  console.log('  ' + '═'.repeat(56));
  console.log(`  concluídos : ${resultado.ok.length}`);
  console.log(`  pulados    : ${resultado.pulados.length}`);
  console.log(`  falhas     : ${resultado.falhas.length}`);
  if (!executar) {
    console.log('');
    console.log('  Isto foi um ENSAIO. Para valer, rode com --executar');
  }
  console.log('');
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  process.exit(1);
});
