// Vigia — o robô conferindo a si mesmo.
//
// Roda dentro do próprio robô, de 15 em 15 minutos, e grava o que encontra na tabela
// robo_alertas. A tela lê de lá e mostra em vermelho no topo.
//
// Antes isto vivia na conversa com o Claude: se a janela fechasse, a vigilância morria
// junto. Agora é do sistema.
//
// COMO FUNCIONA
//   • cada problema tem uma "chave" (ex: sem_estoque_full:ERP)
//   • enquanto o problema existe, a linha fica aberta
//   • quando some, o robô marca resolvido_em sozinho — sem ninguém precisar fechar
//
// O QUE ELE PROCURA
//   1. anúncio sem estoque parado no Full e ninguém cuidando
//   2. patrulha que achou o que consertar e não conseguiu
//   3. tarefa que falhou
//   4. SKU não cadastrado (o sistema não sabe se tem estoque)
//
// Silêncio aqui significa que está tudo certo.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function buscar(url, opcoes = {}, segundos = 30) {
  const abortar = new AbortController();
  const relogio = setTimeout(() => abortar.abort(), segundos * 1000);
  try {
    return await fetch(url, { ...opcoes, signal: abortar.signal });
  } finally {
    clearTimeout(relogio);
  }
}

// Levanta a lista de problemas de agora. Não grava nada — só olha.
async function levantarProblemas(sb) {
  const achados = [];

  // Quando foi a última patrulha? Serve pra saber se algo já teve chance de ser pego.
  const { data: ultima } = await sb.from('ml_patrulha_execucoes')
    .select('quando').order('quando', { ascending: false }).limit(1);
  const minDesdePatrulha = ultima && ultima[0]
    ? (Date.now() - new Date(ultima[0].quando).getTime()) / 60000 : 999;

  // 1) e 4) — a aba "sem estoque" do Mercado Livre
  try {
    const r = await buscar('https://pylkufhziohxvwbbaued.supabase.co/functions/v1/ml-reativar-anuncios', {}, 180);
    const dados = await r.json();

    for (const [conta, res] of Object.entries(dados)) {
      if (!res || typeof res !== 'object') continue;

      const noFull = res.precisa_acao_manual_full || [];
      if (noFull.length) {
        const { data: naFila } = await sb.from('ml_tarefas_robo')
          .select('params').eq('conta', conta).eq('tipo', 'tirar_do_full')
          .in('status', ['pendente', 'rodando']);
        const cuidando = new Set((naFila || []).map((t) => t.params?.item_id));
        const largados = noFull.filter((it) => !cuidando.has(it.item_id));

        // Vender tudo é rotina e a patrulha da hora cheia resolve. Só vira problema
        // se ninguém está cuidando E a patrulha já passou sem pegar.
        if (largados.length && minDesdePatrulha > 70) {
          achados.push({
            chave: `sem_estoque_full:${conta}`, gravidade: 'grave',
            mensagem: `${conta}: ${largados.length} anúncio(s) sem estoque parados no Full — o robô não conseguiu tirar`,
          });
        }
      }

      const desconhecidos = res.sku_nao_reconhecido || [];
      if (desconhecidos.length) {
        achados.push({
          chave: `sku_desconhecido:${conta}`, gravidade: 'aviso',
          mensagem: `${conta}: ${desconhecidos.length} SKU(s) não cadastrado(s) — o sistema não sabe se há estoque`,
        });
      }
    }
  } catch (e) {
    achados.push({
      chave: 'verificacao_sem_estoque', gravidade: 'aviso',
      mensagem: 'não consegui verificar a aba "sem estoque": ' + e.message,
    });
  }

  // 2) patrulha que achou e não resolveu
  const desde = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const { data: exec } = await sb.from('ml_patrulha_execucoes')
    .select('conta, insistindo, erro').gte('quando', desde);
  for (const x of exec || []) {
    if (x.erro) {
      achados.push({ chave: `patrulha_erro:${x.conta}`, gravidade: 'grave', mensagem: `Patrulha da ${x.conta}: ${x.erro}` });
    }
  }

  // Quem ainda está de fato pendente AGORA.
  //
  // Antes isto lia o campo `insistindo` das execuções das últimas 90 minutos — ou seja,
  // uma FOTO do passado. Um anúncio que estava insistindo às 14:47 e cedeu às 14:51
  // mantinha o alerta aceso por mais uma hora e meia, porque a execução velha continuava
  // dentro da janela. Aconteceu de verdade. Agora perguntamos à lista de pendências o
  // que continua em aberto neste instante — some da lista, some o alerta.
  const { data: pendentes } = await sb.from('ml_patrulha_full')
    .select('conta').is('resolvido_em', null).is('desistiu_em', null);
  const porConta = {};
  for (const p of pendentes || []) porConta[p.conta] = (porConta[p.conta] || 0) + 1;
  for (const [conta, qtd] of Object.entries(porConta)) {
    achados.push({
      chave: `patrulha_travada:${conta}`, gravidade: 'aviso',
      mensagem: `${conta}: ${qtd} anúncio(s) fora de venda não cederam — o robô continua tentando`,
    });
  }

  // 3) tarefas que falharam
  const { data: falhas } = await sb.from('ml_tarefas_robo')
    .select('conta, tipo, erro').eq('status', 'falhou').gte('criado_em', desde);
  for (const f of falhas || []) {
    achados.push({
      chave: `tarefa_falhou:${f.conta}:${f.tipo}`, gravidade: 'grave',
      mensagem: `${f.conta}: a tarefa "${f.tipo}" falhou — ${(f.erro || '').slice(0, 120)}`,
    });
  }

  return achados;
}

// Abre o que é novo, atualiza o que continua, e FECHA o que deixou de existir.
// Esse fechamento automático é o que impede a tela de acumular alarme velho.
async function vigiar({ log = () => {} } = {}) {
  const sb = conectar();
  const problemas = await levantarProblemas(sb);
  const agora = new Date().toISOString();

  const { data: abertos } = await sb.from('robo_alertas')
    .select('id, chave').is('resolvido_em', null);
  const jaAbertos = new Map((abertos || []).map((a) => [a.chave, a.id]));

  for (const p of problemas) {
    if (jaAbertos.has(p.chave)) {
      await sb.from('robo_alertas')
        .update({ mensagem: p.mensagem, gravidade: p.gravidade, visto_em: agora })
        .eq('id', jaAbertos.get(p.chave));
      jaAbertos.delete(p.chave);
    } else {
      await sb.from('robo_alertas').insert({ ...p, visto_em: agora });
      log(`  ⚠ ${p.mensagem}`);
    }
  }

  // O que sobrou em jaAbertos não apareceu mais: o problema acabou.
  for (const [chave, id] of jaAbertos) {
    await sb.from('robo_alertas').update({ resolvido_em: agora }).eq('id', id);
    log(`  ✅ resolvido: ${chave}`);
  }

  return { problemas: problemas.length, resolvidos: jaAbertos.size };
}

module.exports = { vigiar };

if (require.main === module) {
  vigiar({ log: console.log }).then((r) => {
    console.log(`\n  ${r.problemas} problema(s) em aberto · ${r.resolvidos} resolvido(s) agora`);
  }).catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
}
