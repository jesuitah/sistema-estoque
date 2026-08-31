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
  const { data: st } = await sb.from('robo_status').select('ultima_batida, parar').eq('id', 1).maybeSingle();
  const minutos = st ? (Date.now() - new Date(st.ultima_batida).getTime()) / 60000 : 999;
  if (minutos > 5) problemas.push(`ROBO FORA DO AR ha ${Math.round(minutos)} min`);
  if (st && st.parar) problemas.push('ROBO PARADO pelo botao de panico');

  // 2) aba "sem estoque" do ML com anúncio ainda no Full
  try {
    const r = await fetch('https://pylkufhziohxvwbbaued.supabase.co/functions/v1/ml-reativar-anuncios');
    const d = await r.json();
    for (const [conta, res] of Object.entries(d)) {
      if (!res || typeof res !== 'object') continue;
      const noFull = (res.precisa_acao_manual_full || []).length;
      if (noFull > 0) problemas.push(`${conta}: ${noFull} anuncio(s) sem estoque AINDA no Full`);
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
