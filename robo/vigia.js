// Vigia — confere se o robô está de fato dando conta, e só fala quando há problema.
//
// Silêncio aqui significa que está tudo certo. Ele imprime UMA linha por problema
// encontrado, e nada quando não há nenhum.
//
// O que ele procura, nas 3 lojas:
//   1. anúncio parado no Full sem unidade nenhuma (não vende e não sai da lista)
//   2. anúncio na aba "sem estoque" do ML que continua no Full
//   3. passada da patrulha que achou o que consertar e não consertou
//   4. robô fora do ar
//
// Como usar:  node vigia.js

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

async function main() {
  const sb = conectar();
  const problemas = [];

  // 1) robô vivo?
  //
  // Trabalho longo (patrulha, varredura de promoções) trava o laço principal e o ponto
  // atrasa. Isso NÃO é robô morto — e gritar "fora do ar" nessas horas é alarme falso,
  // que ensina a ignorar o vigia. Se o detalhe mostra trabalho em andamento, sabemos
  // que ele está vivo.
  const { data: st } = await sb.from('robo_status').select('ultima_batida, parar, detalhe').eq('id', 1).maybeSingle();
  const trabalhando = !!(st?.detalhe?.patrulhando || st?.detalhe?.varrendo_promocoes);
  const minutos = st ? (Date.now() - new Date(st.ultima_batida).getTime()) / 60000 : 999;
  if (!trabalhando && minutos > 5) problemas.push(`ROBO FORA DO AR ha ${Math.round(minutos)} min`);
  if (trabalhando && minutos > 45) problemas.push(`ROBO TRAVADO num trabalho longo ha ${Math.round(minutos)} min`);
  if (st && st.parar) problemas.push('ROBO PARADO pelo botao de panico');

  // 2) aba "sem estoque" do ML com anúncio ainda no Full
  //
  // Anúncio vende tudo o tempo todo — aparecer aqui é rotina, e a patrulha da hora
  // cheia resolve. Só é problema se NINGUÉM está cuidando: sem tarefa na fila e com
  // a última patrulha já passada. Sem esse filtro o vigia gritava de 15 em 15 minutos
  // por algo que já tinha solução marcada, e alarme falso ensina a ignorar o vigia.
  const { data: ultima } = await sb.from('ml_patrulha_execucoes')
    .select('quando').order('quando', { ascending: false }).limit(1);
  const minDesdePatrulha = ultima && ultima[0]
    ? (Date.now() - new Date(ultima[0].quando).getTime()) / 60000 : 999;

  try {
    const r = await fetch('https://pylkufhziohxvwbbaued.supabase.co/functions/v1/ml-reativar-anuncios');
    const d = await r.json();
    for (const [conta, res] of Object.entries(d)) {
      if (!res || typeof res !== 'object') continue;

      const noFull = res.precisa_acao_manual_full || [];
      if (noFull.length) {
        // Quais já estão na fila do robô?
        const { data: naFila } = await sb.from('ml_tarefas_robo')
          .select('params').eq('conta', conta).eq('tipo', 'tirar_do_full')
          .in('status', ['pendente', 'rodando']);
        const cuidando = new Set((naFila || []).map((t) => t.params?.item_id));
        const largados = noFull.filter((it) => !cuidando.has(it.item_id));

        // Largados só viram problema se a patrulha já passou e não os pegou.
        if (largados.length && minDesdePatrulha > 70) {
          problemas.push(`${conta}: ${largados.length} anuncio(s) sem estoque no Full e ninguem cuidando`);
        }
      }

      const desconhecidos = (res.sku_nao_reconhecido || []).length;
      if (desconhecidos > 0) problemas.push(`${conta}: ${desconhecidos} SKU(s) nao cadastrado(s)`);
    }
  } catch (e) {
    problemas.push('nao consegui verificar a aba sem estoque: ' + e.message);
  }

  // 3) patrulha achou e não resolveu, nas passadas recentes
  const desde = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const { data: exec } = await sb.from('ml_patrulha_execucoes')
    .select('conta, alvos, agidos, insistindo, erro, quando')
    .gte('quando', desde);
  for (const x of exec || []) {
    if (x.erro) problemas.push(`patrulha ${x.conta}: ${x.erro}`);
    else if ((x.insistindo || 0) > 0) problemas.push(`patrulha ${x.conta}: ${x.insistindo} anuncio(s) nao cederam`);
  }

  // 4) tarefas do robô que falharam
  const { data: falhas } = await sb.from('ml_tarefas_robo')
    .select('conta, tipo, erro').eq('status', 'falhou').gte('criado_em', desde);
  for (const f of falhas || []) problemas.push(`tarefa ${f.conta}/${f.tipo} falhou: ${(f.erro || '').slice(0, 80)}`);

  if (problemas.length) problemas.forEach((p) => console.log('PROBLEMA: ' + p));
}

main().catch((e) => console.log('PROBLEMA: vigia quebrou — ' + e.message));
