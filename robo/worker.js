// Robô trabalhador — fica rodando no PC do Matheus e executa a fila de tarefas.
//
// Como usar:   node worker.js
//              node worker.js --uma-vez     (processa o que houver e encerra)
//
// COMO SE ENCAIXA
//   site  →  tabela ml_tarefas_robo  →  ESTE PROGRAMA  →  Mercado Livre
//         enfileira                      executa e confirma
//
// O site nunca fala com o navegador. Ele só escreve na fila. Se o PC estiver
// desligado, a tarefa espera — nada se perde.
//
// TRAVAS
//   • uma tarefa por vez, com pausa entre elas (ritmo humano)
//   • só horário comercial (configurável abaixo)
//   • botão de pânico: robo_status.parar = true faz o robô parar de pegar tarefa
//   • toda ação é confirmada pela API oficial depois — não acredita em si mesmo
//   • tarefa que falha NÃO é repetida às cegas: fica marcada como 'falhou' com o motivo

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { abrirNavegador, identificarConta, USER_IDS_ESPERADOS } = require('./navegador');

const SUPABASE_URL = 'https://pylkufhziohxvwbbaued.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || lerChaveDoSite();

const PAINEL = 'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management';
const ENDPOINT = 'https://vendedores.mercadolivre.com.br/stock-management/space-management/api/actions';

const INTERVALO_FILA_MS = 3000;    // de quanto em quanto tempo olha a fila
const PAUSA_ENTRE_TAREFAS_MS = 1500;
const VALIDADE_CSRF_MS = 20 * 60 * 1000; // o código de segurança vale pra sessão toda
const OCIOSO_ATE_FECHAR_MS = 90 * 1000;  // sem tarefa por 1min30, fecha o navegador
const BATIDA_MS = 60000;           // sinal de vida
const HORA_INICIO = 7;             // só trabalha entre 7h e 22h
const HORA_FIM = 22;
const VERSAO = '1.0';

// A chave pública do Supabase já está no index.html do site — reaproveitamos daqui
// pra não duplicar credencial em dois lugares.
function lerChaveDoSite() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const m = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  } catch (_e) { /* cai no erro abaixo */ }
  throw new Error('Não achei a chave do Supabase no index.html. Defina SUPABASE_KEY no ambiente.');
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function agora() {
  return new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function log(msg) {
  console.log(`  ${agora()}  ${msg}`);
}

function dentroDoHorario() {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
  return h >= HORA_INICIO && h < HORA_FIM;
}

// Token da conta, lido do BANCO a cada uso.
//
// Não usar arquivo estático aqui: o token do Mercado Livre dura ~6h e o arquivo
// envelhece (deu 401 em teste real). No banco ele está sempre fresco, porque as
// Edge Functions renovam sozinhas a cada sincronização (de 5 em 5 minutos).
async function tokenDaConta(conta) {
  const { data, error } = await sb.from('ml_tokens')
    .select('conta, user_id, access_token, expires_at')
    .eq('conta', conta)
    .maybeSingle();
  if (error) throw new Error(`não consegui ler o token de ${conta}: ${error.message}`);
  if (!data) throw new Error(`conta ${conta} não encontrada em ml_tokens`);

  const minutosRestantes = (new Date(data.expires_at).getTime() - Date.now()) / 60000;
  if (minutosRestantes < 0) {
    throw new Error(
      `o token da ${conta} está vencido no banco. Ele se renova sozinho na próxima ` +
      `sincronização (a cada 5 min) — tente de novo em instantes.`
    );
  }
  return data;
}

// Fonte de verdade: a API oficial, nunca a tela.
async function estadoDoAnuncio(itemId, accessToken) {
  const r = await fetch(
    `https://api.mercadolibre.com/items/${itemId}?attributes=id,title,status,shipping,user_product_id`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!r.ok) return { erro: `API do ML respondeu ${r.status}` };
  const i = await r.json();
  return {
    titulo: i.title,
    status: i.status,
    logistic_type: i.shipping?.logistic_type ?? null,
    no_full: i.shipping?.logistic_type === 'fulfillment',
    user_product_id: i.user_product_id ?? null,
  };
}

// ── Tarefa: tirar do Full ────────────────────────────────────────────────────
// Reproduz a chamada que o painel faz (capturada com gravar.js). Não imita cliques.

// O código de segurança (csrf) vale pra sessão inteira, não por tarefa. Carregar a
// página do painel a cada anúncio era o que deixava tudo lento (10 a 40s por item),
// então guardamos e reaproveitamos.
const csrfPorConta = {};

async function obterCsrf(pagina, conta, forcar) {
  const guardado = csrfPorConta[conta];
  if (!forcar && guardado && (Date.now() - guardado.quando) < VALIDADE_CSRF_MS) {
    return guardado.valor;
  }
  await pagina.goto(PAINEL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pagina.waitForFunction(
    () => !!document.querySelector('meta[name*=csrf i], meta[name*=xsrf i]'),
    { timeout: 45000 }
  ).catch(() => {});

  const valor = await pagina.evaluate(() => {
    const m = document.querySelector('meta[name*=csrf i], meta[name*=xsrf i]');
    return m ? m.getAttribute('content') : null;
  });
  if (!valor) throw new Error('não encontrei o x-csrf-token na página — interrompendo em vez de chutar');
  csrfPorConta[conta] = { valor, quando: Date.now() };
  return valor;
}

// Espera a API oficial refletir a mudança, tentando algumas vezes em vez de dormir
// um tempo fixo. Costuma confirmar na primeira ou segunda tentativa.
async function esperarSairDoFull(itemId, accessToken, tentativas = 6) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 2000));
    const estado = await estadoDoAnuncio(itemId, accessToken);
    if (!estado.erro && !estado.no_full) return estado;
    if (i === tentativas - 1) return estado;
  }
}

async function tirarDoFull(navegador, pagina, tarefa, accessToken) {
  const itemId = tarefa.params?.item_id;
  if (!itemId) throw new Error('tarefa sem item_id nos parâmetros');

  const antes = await estadoDoAnuncio(itemId, accessToken);
  if (antes.erro) throw new Error(antes.erro);
  if (!antes.no_full) {
    return { ok: true, nada_a_fazer: true, motivo: 'anúncio já não está no Full', logistic_type: antes.logistic_type };
  }
  if (!antes.user_product_id) throw new Error('anúncio sem user_product_id — a chamada exige esse id');

  const disparar = (csrf, actionId) => pagina.evaluate(async ({ endpoint, csrf, actionId, id }) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
      body: JSON.stringify({ actionId, ids: [id] }),
      credentials: 'include',
    });
    let corpo = null;
    try { corpo = await r.json(); } catch (_e) { /* resposta sem json */ }
    return { status: r.status, corpo };
  }, { endpoint: ENDPOINT, csrf, actionId, id: antes.user_product_id });

  let csrf = await obterCsrf(pagina, tarefa.conta, false);
  let v = await disparar(csrf, 'MAKE_NO_OFFER_FULL_VALIDATE');

  // 401/403 costuma ser código de segurança vencido: pega um novo e tenta de novo,
  // uma única vez. Qualquer outra recusa interrompe.
  if (v.status === 401 || v.status === 403) {
    csrf = await obterCsrf(pagina, tarefa.conta, true);
    v = await disparar(csrf, 'MAKE_NO_OFFER_FULL_VALIDATE');
  }
  if (v.status !== 200) throw new Error(`validação recusada (HTTP ${v.status})`);

  const a = await disparar(csrf, 'MAKE_NO_OFFER_FULL_ACTION');
  if (a.status !== 200) throw new Error(`ação recusada (HTTP ${a.status})`);

  const depois = await esperarSairDoFull(itemId, accessToken);
  if (depois.no_full) {
    return {
      ok: false,
      titulo: antes.titulo,
      de: antes.logistic_type,
      para: depois.logistic_type,
      observacao: 'o painel aceitou, mas a API ainda mostra no Full — pode levar alguns minutos pra refletir',
    };
  }

  // Fora do Full, o resto é pela API oficial. O que fazer aqui vem decidido na tarefa:
  //   'ativar'   -> temos a peça: reativa e deixa vendendo
  //   'inativar' -> não temos: reativa e pausa, pra sair da aba "sem estoque"
  const acaoDepois = tarefa.params?.acao_depois || null;
  let seguimento = null;
  if (acaoDepois === 'ativar' || acaoDepois === 'inativar') {
    seguimento = await reativarAnuncio(itemId, accessToken, acaoDepois === 'inativar');
  }

  return {
    ok: true,
    titulo: antes.titulo,
    de: antes.logistic_type,
    para: depois.logistic_type,
    aviso_do_painel: a.corpo?.snackbar?.message ?? null,
    acao_depois: acaoDepois,
    seguimento,
  };
}

// Reativa com 89 unidades (padrão da empresa) e, se pedido, pausa em seguida.
// Reativar-e-pausar é o que troca o motivo da pausa de "sem estoque" para "pausado
// pelo vendedor" — é assim que o anúncio sai da aba e vai pra "inativos".
const QUANTIDADE_PADRAO = 89;

async function reativarAnuncio(itemId, accessToken, pausarDepois) {
  const H = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  const ativar = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ status: 'active', available_quantity: QUANTIDADE_PADRAO }),
  });
  if (!ativar.ok) {
    const detalhe = await ativar.text().catch(() => '');
    return { ok: false, etapa: 'ativar', http: ativar.status, detalhe: detalhe.slice(0, 300) };
  }
  if (!pausarDepois) return { ok: true, ficou: 'ativo' };

  await new Promise((r) => setTimeout(r, 1500));
  const pausar = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ status: 'paused' }),
  });
  if (!pausar.ok) {
    const detalhe = await pausar.text().catch(() => '');
    return { ok: false, etapa: 'pausar', http: pausar.status, detalhe: detalhe.slice(0, 300) };
  }
  return { ok: true, ficou: 'inativo' };
}

const EXECUTORES = { tirar_do_full: tirarDoFull };

// ── Ciclo principal ──────────────────────────────────────────────────────────
async function baterPonto(detalhe) {
  await sb.from('robo_status').update({
    ultima_batida: new Date().toISOString(),
    versao: VERSAO,
    detalhe: detalhe ?? null,
  }).eq('id', 1);
}

// Se o robô for fechado no meio de uma tarefa (PC desligado, programa encerrado),
// ela fica presa em 'rodando' e ninguém mais pega. Aqui devolvemos pra fila as que
// ficaram paradas tempo demais — nenhuma ação leva mais que ~1 minuto.
const MINUTOS_PARA_CONSIDERAR_ORFA = 10;

async function resgatarTarefasOrfas() {
  const limite = new Date(Date.now() - MINUTOS_PARA_CONSIDERAR_ORFA * 60 * 1000).toISOString();
  const { data } = await sb.from('ml_tarefas_robo')
    .update({ status: 'pendente', iniciado_em: null })
    .eq('status', 'rodando')
    .lt('iniciado_em', limite)
    .select('id');
  if (data && data.length) {
    log(`↺ ${data.length} tarefa(s) travada(s) devolvida(s) pra fila`);
  }
}

async function devoParar() {
  const { data } = await sb.from('robo_status').select('parar').eq('id', 1).maybeSingle();
  return !!data?.parar;
}

// Pega a próxima tarefa RESERVANDO-A no mesmo passo.
//
// O update filtra por status='pendente': se dois robôs tentarem a mesma tarefa ao
// mesmo tempo, só um consegue alterar a linha — o outro recebe vazio e vai pra
// próxima. Sem isso, o robô automático e um aberto na mão poderiam executar a
// mesma ação duas vezes.
async function reservarProximaTarefa() {
  const { data: candidatas } = await sb.from('ml_tarefas_robo')
    .select('id').eq('status', 'pendente').order('criado_em', { ascending: true }).limit(5);
  if (!candidatas || !candidatas.length) return null;

  for (const { id } of candidatas) {
    const { data: reservada } = await sb.from('ml_tarefas_robo')
      .update({ status: 'rodando', iniciado_em: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pendente')   // <- a corrida é decidida aqui
      .select()
      .maybeSingle();
    if (reservada) return reservada;
  }
  return null;
}

// Reconhece o erro de "o navegador não está mais lá". Só nesse caso vale reabrir e
// tentar de novo — em qualquer outro, insistir seria chutar.
function ehNavegadorMorto(erro) {
  return /Target page, context or browser has been closed|Browser has been closed|Target closed|Protocol error/i
    .test(String(erro && erro.message ? erro.message : erro));
}

async function descartarNavegador(navegadores, conta) {
  const guardado = navegadores[conta];
  if (guardado) {
    await guardado.nav.close().catch(() => {});
    delete navegadores[conta];
  }
  delete csrfPorConta[conta]; // o código de segurança pertencia àquela sessão
}

// Abre (ou reaproveita) o navegador da conta, sempre conferindo que a sessão logada
// é mesmo a esperada antes de deixar agir.
//
// IMPORTANTE — só UM navegador aberto por vez.
// Manter um Chrome por conta parecia bom pra velocidade, mas cada um come centenas de
// megabytes. Num PC de 8 GB isso derrubou a máquina pra menos de 1 GB livre e a página
// do painel parou de carregar (as tarefas falhavam com "não encontrei o csrf").
// Trocar de conta é raro; deixar o PC do Matheus travado é inaceitável.
async function navegadorDaConta(navegadores, conta) {
  const guardado = navegadores[conta];
  if (guardado && guardado.nav.pages().length > 0) return guardado;
  if (guardado) await descartarNavegador(navegadores, conta);

  for (const outra of Object.keys(navegadores)) {
    if (outra !== conta) {
      log(`  fechando navegador da ${outra} pra liberar memória`);
      await descartarNavegador(navegadores, outra);
    }
  }

  const nav = await abrirNavegador(conta);
  const quem = await identificarConta(nav);
  if (quem.userId && quem.userId !== USER_IDS_ESPERADOS[conta]) {
    await nav.close().catch(() => {});
    throw new Error(`sessão da conta errada: esperava ${conta}, achei id ${quem.userId}`);
  }
  navegadores[conta] = { nav, pagina: nav.pages()[0] || (await nav.newPage()) };
  log(`  navegador aberto para ${conta} (${quem.apelido})`);
  return navegadores[conta];
}

async function processar(tarefa, navegadores) {
  log(`▶ tarefa #${tarefa.id} — ${tarefa.tipo} · ${tarefa.conta} · ${tarefa.params?.item_id ?? ''}`);

  // a tarefa já veio reservada (status 'rodando'); aqui só contamos a tentativa
  await sb.from('ml_tarefas_robo')
    .update({ tentativas: (tarefa.tentativas ?? 0) + 1 })
    .eq('id', tarefa.id);

  try {
    const executor = EXECUTORES[tarefa.tipo];
    if (!executor) throw new Error(`tipo de tarefa desconhecido: ${tarefa.tipo}`);

    const cred = await tokenDaConta(tarefa.conta);

    let resultado;
    try {
      const { nav, pagina } = await navegadorDaConta(navegadores, tarefa.conta);
      resultado = await executor(nav, pagina, tarefa, cred.access_token);
    } catch (erro) {
      // O navegador guardado pode ter morrido entre uma tarefa e outra (fechado à mão,
      // travado, perfil em uso por outro processo). Nesse caso não adianta insistir com
      // ele: descartamos, abrimos outro e tentamos UMA vez. Qualquer outro erro sobe.
      if (!ehNavegadorMorto(erro)) throw erro;
      log('  navegador havia fechado — reabrindo e tentando de novo');
      await descartarNavegador(navegadores, tarefa.conta);
      const { nav, pagina } = await navegadorDaConta(navegadores, tarefa.conta);
      resultado = await executor(nav, pagina, tarefa, cred.access_token);
    }

    if (resultado.ok) {
      await sb.from('ml_tarefas_robo')
        .update({ status: 'feito', resultado, concluido_em: new Date().toISOString(), erro: null })
        .eq('id', tarefa.id);
      log(`  ✅ #${tarefa.id} concluída${resultado.para ? ` (${resultado.de} → ${resultado.para})` : ''}`);
    } else {
      await sb.from('ml_tarefas_robo')
        .update({ status: 'falhou', resultado, erro: resultado.observacao ?? 'não deu pra confirmar o resultado', concluido_em: new Date().toISOString() })
        .eq('id', tarefa.id);
      log(`  ⚠ #${tarefa.id} sem confirmação`);
    }
  } catch (erro) {
    await sb.from('ml_tarefas_robo')
      .update({ status: 'falhou', erro: String(erro.message ?? erro), concluido_em: new Date().toISOString() })
      .eq('id', tarefa.id);
    log(`  ❌ #${tarefa.id} falhou: ${erro.message}`);
  }
}

async function main() {
  const umaVez = process.argv.includes('--uma-vez');

  console.log('');
  console.log('  ┌──────────────────────────────────────────────────┐');
  console.log(`  │  ROBÔ ATIVO — versão ${VERSAO}                          │`);
  console.log('  │  Aguardando tarefas enviadas pelo sistema.        │');
  console.log('  │  Pode deixar esta janela aberta e minimizada.     │');
  console.log('  └──────────────────────────────────────────────────┘');
  console.log('');

  const navegadores = {};
  let ultimaBatida = 0;
  let ultimoResgate = 0;
  let ultimaTarefa = Date.now();

  await resgatarTarefasOrfas();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (Date.now() - ultimaBatida > BATIDA_MS) {
        await baterPonto({ horario_ok: dentroDoHorario() });
        ultimaBatida = Date.now();
      }
      if (Date.now() - ultimoResgate > 5 * 60 * 1000) {
        await resgatarTarefasOrfas();
        ultimoResgate = Date.now();
      }

      if (await devoParar()) {
        log('⏸ parada solicitada pelo sistema — sem pegar tarefas');
        await new Promise((r) => setTimeout(r, INTERVALO_FILA_MS));
        continue;
      }

      if (!dentroDoHorario()) {
        if (umaVez) break;
        await new Promise((r) => setTimeout(r, INTERVALO_FILA_MS));
        continue;
      }

      const tarefa = await reservarProximaTarefa();
      if (!tarefa) {
        // Sem trabalho: fecha o navegador depois de um tempinho parado. Ele não pode
        // ficar ocupando memória o dia inteiro só esperando — o PC é de trabalho.
        if (Object.keys(navegadores).length && Date.now() - ultimaTarefa > OCIOSO_ATE_FECHAR_MS) {
          for (const c of Object.keys(navegadores)) await descartarNavegador(navegadores, c);
          log('navegador fechado por ociosidade (abre de novo quando chegar tarefa)');
        }
        if (umaVez) break;
        await new Promise((r) => setTimeout(r, INTERVALO_FILA_MS));
        continue;
      }

      await processar(tarefa, navegadores);
      ultimaTarefa = Date.now();
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_TAREFAS_MS));
    } catch (erro) {
      log(`erro no ciclo: ${erro.message}`);
      await new Promise((r) => setTimeout(r, INTERVALO_FILA_MS));
    }
  }

  for (const { nav } of Object.values(navegadores)) await nav.close().catch(() => {});
  console.log('');
  log('robô encerrado.');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
