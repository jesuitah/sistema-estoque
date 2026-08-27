// Patrulha do "Fora de venda" — reativa anúncios que o Mercado Livre tirou de venda.
//
// Usado pelo worker.js de tempos em tempos. Também roda sozinho pra teste:
//    node patrulha-full.js            → ENSAIO (lê e mostra, não age)
//    node patrulha-full.js --executar → age de verdade
//    node patrulha-full.js ERP --executar
//
// POR QUE PRECISA INSISTIR
// O painel responde 200 mesmo quando não executa. Foi medido: o Matheus disparou a
// mesma ação três vezes no mesmo anúncio, todas com 200, e nada mudou. Depois de
// alguma insistência, pega. Por isso o sucesso NÃO é a resposta da chamada — é o
// anúncio SUMIR da lista. É assim que conferimos.
//
// AS DUAS RECOMENDAÇÕES QUE TRATAMOS (decisão do Matheus)
//   "Ofereça o Full novamente" -> MAKE_OFFER_FULL
//   "Reative o produto"        -> MAKE_REACTIVATE_ITEM
// Qualquer outra ("Retire as unidades...", "Você ainda não tem recomendações") é
// deixada em paz.

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { abrirNavegador, sessaoExiste, identificarConta, USER_IDS_ESPERADOS, CONTAS_VALIDAS } = require('./navegador');

const PAINEL = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';
const ENDPOINT = 'https://vendedores.mercadolivre.com.br/stock-management/space-management/api/actions';
const MAX_PAGINAS = 30;
const LIMITE_TENTATIVAS = 20;   // depois disso, para de insistir e sinaliza
const LOTE_MAXIMO = 20;         // ids por chamada

const ACOES = [
  { teste: /ofere[çc]a o full novamente/i, actionId: 'MAKE_OFFER_FULL',      rotulo: 'oferecer Full novamente' },
  { teste: /reative o produto/i,           actionId: 'MAKE_REACTIVATE_ITEM', rotulo: 'reativar anúncio' },
];

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function esperarTabela(pagina) {
  await pagina
    .waitForFunction(() => /C[óo]digo ML/i.test(document.body.innerText || ''), { timeout: 45000 })
    .catch(() => {});
  await pagina.waitForTimeout(1500);
}

// Conta o total de anúncios que a lista tem, pra poder mostrar progresso.
async function totalDaLista(pagina) {
  return pagina.evaluate(() => {
    const m = (document.body.innerText || '').match(/([\d.]+)\s+resultados/i);
    return m ? parseInt(m[1].replace(/\./g, ''), 10) : null;
  });
}

// Lê a lista inteira e devolve só o que nos interessa.
// `aoAndar` é chamado a cada página, pra tela conseguir mostrar o robô trabalhando.
async function lerLista(pagina, aoAndar) {
  const todos = [];
  const vistos = new Set();
  let total = null;

  for (let n = 1; n <= MAX_PAGINAS; n++) {
    await pagina.goto(n === 1 ? PAINEL : `${PAINEL}?page=${n}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await esperarTabela(pagina);
    if (total === null) total = await totalDaLista(pagina);

    const linhas = await pagina.evaluate(() => {
      const limpar = (s) => (s || '').trim().replace(/\s+/g, ' ');
      return [...document.querySelectorAll('tr')].slice(1).map((tr) => {
        const c = [...tr.querySelectorAll('td,th')].map((x) => limpar(x.innerText));
        const bruto = c[0] || '';
        return {
          codigo_ml: (bruto.match(/C[óo]digo ML:\s*([A-Z0-9]+)/i) || [])[1] || null,
          titulo: limpar(bruto.replace(/.*C[óo]digo ML:\s*[A-Z0-9]+/i, '').replace(/^[\s+\d]*/, '')).slice(0, 70),
          acao_sugerida: c[8] || null,
          // O id que a reativação precisa (MLBU...) é colhido AQUI, junto com o resto
          // da linha. Antes ele era procurado depois, numa segunda passada — e como a
          // leitura termina na última página, as linhas das páginas anteriores já não
          // estavam mais no DOM. Colher na hora resolve isso de vez.
          //
          // Ele fica no id das células (id="product-MLBU..."), não em link: a tabela do
          // ML não tem mais <a href>. Por isso lemos o HTML da linha, que é onde ele
          // está, em vez de depender de um lugar específico que pode mudar de novo.
          user_product_id: (tr.outerHTML.match(/MLBU\d+/) || [])[0] || null,
        };
      }).filter((r) => r.codigo_ml);
    });

    if (!linhas.length) break;
    if (vistos.has(linhas[0].codigo_ml)) break;
    let novos = 0;
    for (const l of linhas) {
      if (vistos.has(l.codigo_ml)) continue;
      vistos.add(l.codigo_ml);
      todos.push(l);
      novos++;
    }
    if (aoAndar) await aoAndar(todos.length, total);
    if (!novos) break;
  }
  return todos;
}

async function obterCsrf(pagina) {
  const v = await pagina.evaluate(() => {
    const m = document.querySelector('meta[name*=csrf i], meta[name*=xsrf i]');
    return m ? m.getAttribute('content') : null;
  });
  if (!v) throw new Error('não encontrei o x-csrf-token na página');
  return v;
}

async function disparar(pagina, csrf, actionId, ids) {
  return pagina.evaluate(async ({ endpoint, csrf, actionId, ids }) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
      body: JSON.stringify({ actionId, ids }),
      credentials: 'include',
    });
    let corpo = null;
    try { corpo = await r.json(); } catch (_e) { /* sem json */ }
    return { status: r.status, corpo };
  }, { endpoint: ENDPOINT, csrf, actionId, ids });
}

// ── Uma passada em uma conta ─────────────────────────────────────────────────
async function patrulharConta(sb, conta, executar, log) {
  if (!sessaoExiste(conta)) { log(`  ${conta}: sem sessão salva, pulando`); return null; }

  const navegador = await abrirNavegador(conta);
  try {
    const quem = await identificarConta(navegador);
    if (quem.userId && quem.userId !== USER_IDS_ESPERADOS[conta]) {
      throw new Error(`sessão da conta errada: esperava ${conta}, achei ${quem.userId}`);
    }
    const pagina = navegador.pages()[0] || (await navegador.newPage());

    // Vai avisando a tela onde está. Sem isso, uma passada de 2 minutos parece
    // que nada acontece — e o Matheus perde a noção de que o robô está vivo.
    const lista = await lerLista(pagina, async (lidos, total) => {
      await sb.from('robo_status').update({
        detalhe: { patrulhando: true, conta, lidos, total },
      }).eq('id', 1).then(() => {}, () => {});
    });
    const alvos = lista
      .map((l) => ({ ...l, acao: ACOES.find((a) => a.teste.test(l.acao_sugerida || '')) }))
      .filter((l) => l.acao);

    // Quem estava pendente e NÃO apareceu mais: sumiu da lista = resolvido.
    const codigosNaTela = new Set(lista.map((l) => l.codigo_ml));
    const { data: pendentes } = await sb.from('ml_patrulha_full')
      .select('id, codigo_ml, tentativas').eq('conta', conta).is('resolvido_em', null);
    const resolvidos = (pendentes || []).filter((p) => !codigosNaTela.has(p.codigo_ml));
    if (resolvidos.length && executar) {
      await sb.from('ml_patrulha_full')
        .update({ resolvido_em: new Date().toISOString() })
        .in('id', resolvidos.map((r) => r.id));
      for (const r of resolvidos) {
        await sb.from('ml_log_acoes').insert({
          conta, item_id: r.codigo_ml, title: null, acao: 'reativado', origem: 'robo',
          detalhe: `voltou a vender no Full (após ${r.tentativas} tentativa(s))`,
        });
      }
      log(`  ${conta}: ${resolvidos.length} voltaram a vender ✅`);
    }

    if (!alvos.length) {
      log(`  ${conta}: ${lista.length} no Full · nada pra reativar`);
      return { conta, lidos: lista.length, alvos: 0, resolvidos: resolvidos.length };
    }

    // Registra/atualiza cada alvo e descobre quantas tentativas já levou
    const paraAgir = [];
    const semId = [];
    for (const alvo of alvos) {
      const up = alvo.user_product_id;
      const { data: existente } = await sb.from('ml_patrulha_full')
        .select('id, tentativas, desistiu_em').eq('conta', conta).eq('codigo_ml', alvo.codigo_ml).maybeSingle();

      if (existente?.desistiu_em) continue;                    // já desistimos deste
      if (existente && existente.tentativas >= LIMITE_TENTATIVAS) {
        if (executar) {
          await sb.from('ml_patrulha_full').update({ desistiu_em: new Date().toISOString() }).eq('id', existente.id);
          await sb.from('ml_log_acoes').insert({
            conta, item_id: alvo.codigo_ml, title: alvo.titulo, acao: 'falhou', origem: 'robo',
            detalhe: `o Mercado Livre não reativou após ${existente.tentativas} tentativas — precisa de você`,
          });
        }
        log(`  ${conta}: desistindo de ${alvo.codigo_ml} após ${existente.tentativas} tentativas`);
        continue;
      }
      // Sem o id não dá pra agir. Isto NÃO pode passar batido: foi exatamente assim
      // que o robô ficou 110 passadas sem consertar nada parecendo saudável — ele
      // "pulava" cada anúncio numa linha de log que ninguém lia, e a tela dizia
      // "Feito, ok". Agora vira erro visível na tela.
      if (!up) { semId.push(alvo.codigo_ml); continue; }
      paraAgir.push({ ...alvo, user_product_id: up, registro: existente });
    }

    if (semId.length) {
      log(`  ${conta}: ⚠ ${semId.length} anúncio(s) sem id na tela — o painel do ML deve ter mudado`);
    }

    if (!paraAgir.length) {
      return {
        conta, lidos: lista.length, alvos: alvos.length, agidos: 0, resolvidos: resolvidos.length,
        // Alvo encontrado e nenhuma ação possível é FALHA, não rotina.
        erro: semId.length
          ? `${semId.length} anúncio(s) precisam de conserto mas o robô não achou o id na tela — o painel do ML mudou`
          : null,
      };
    }

    if (!executar) {
      log(`  ${conta}: [ensaio] agiria em ${paraAgir.length}:`);
      paraAgir.forEach((a) => log(`      ${a.codigo_ml} → ${a.acao.rotulo}`));
      return { conta, lidos: lista.length, alvos: alvos.length, agidos: 0, ensaio: paraAgir.length, resolvidos: resolvidos.length };
    }

    const csrf = await obterCsrf(pagina);
    let agidos = 0;

    // agrupa por ação e dispara em lote (é o que o painel faz)
    for (const acao of ACOES) {
      const grupo = paraAgir.filter((a) => a.acao.actionId === acao.actionId);
      for (let i = 0; i < grupo.length; i += LOTE_MAXIMO) {
        const lote = grupo.slice(i, i + LOTE_MAXIMO);
        const r = await disparar(pagina, csrf, acao.actionId, lote.map((x) => x.user_product_id));
        const aceitou = r.status === 200;
        log(`  ${conta}: ${acao.rotulo} em ${lote.length} anúncio(s) → HTTP ${r.status}`);

        for (const item of lote) {
          const tentativas = (item.registro?.tentativas || 0) + 1;
          if (item.registro) {
            await sb.from('ml_patrulha_full').update({
              tentativas, vista_em: new Date().toISOString(), ultima_acao_em: new Date().toISOString(),
              recomendacao: item.acao_sugerida, titulo: item.titulo, user_product_id: item.user_product_id,
            }).eq('id', item.registro.id);
          } else {
            await sb.from('ml_patrulha_full').insert({
              conta, codigo_ml: item.codigo_ml, user_product_id: item.user_product_id,
              titulo: item.titulo, recomendacao: item.acao_sugerida,
              tentativas, ultima_acao_em: new Date().toISOString(),
            });
          }
        }
        if (aceitou) agidos += lote.length;
        await new Promise((res) => setTimeout(res, 2000));
      }
    }

    return { conta, lidos: lista.length, alvos: alvos.length, agidos, resolvidos: resolvidos.length };
  } finally {
    await navegador.close().catch(() => {});
  }
}

async function patrulhar({ executar = false, contas = CONTAS_VALIDAS, log = console.log } = {}) {
  const sb = conectar();
  const resultados = [];
  for (const c of contas) {
    try {
      const r = await patrulharConta(sb, c, executar, log);
      if (r) {
        resultados.push(r);
        // Registra a passada mesmo quando não houve nada a fazer — é justamente
        // esse registro que diz ao Matheus que o robô está vivo e trabalhando.
        if (executar) {
          await sb.from('ml_patrulha_execucoes').insert({
            conta: c, lidos: r.lidos || 0, alvos: r.alvos || 0,
            agidos: r.agidos || 0, resolvidos: r.resolvidos || 0,
          }).then(() => {}, () => {});
        }
      }
    } catch (erro) {
      log(`  ${c}: erro — ${erro.message}`);
      if (executar) {
        await sb.from('ml_patrulha_execucoes').insert({
          conta: c, erro: String(erro.message || erro).split('\n')[0].slice(0, 200),
        }).then(() => {}, () => {});
      }
    }
  }
  return resultados;
}

module.exports = { patrulhar, LIMITE_TENTATIVAS };

// execução direta (teste manual)
if (require.main === module) {
  const args = process.argv.slice(2);
  const executar = args.includes('--executar');
  const conta = args.find((a) => /^(KMP|ERP|LTS)$/i.test(a));
  console.log('');
  console.log(`  PATRULHA DO FULL — ${executar ? '*** EXECUÇÃO REAL ***' : 'ENSAIO (não altera nada)'}`);
  console.log('  ' + '═'.repeat(56));
  patrulhar({ executar, contas: conta ? [conta.toUpperCase()] : CONTAS_VALIDAS })
    .then((r) => {
      console.log('');
      console.log('  ' + JSON.stringify(r));
      if (!executar) console.log('  Isto foi um ENSAIO. Para valer: --executar');
      console.log('');
    })
    .catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
}
