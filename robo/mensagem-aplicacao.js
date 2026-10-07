// Manda a mensagem de confirmação de aplicação ao comprador, pelo painel.
//
// POR QUE PELO PAINEL E NÃO PELA API
// A API do Mercado Livre RECUSA o vendedor iniciar conversa:
//     403 blocked_by_conversation_initiated_by_seller_limited
// Medido em 06/10/2026: 17 de 30 pedidos das últimas 48h da KMP. Não é erro nosso,
// é política deles. No painel o botão "Iniciar conversa" existe e funciona — então
// essa é a única porta, igual à embalagem de fábrica.
//
// O QUE A MENSAGEM FAZ
// É a mesma que a Letícia manda hoje na mão em toda venda que não é Full: pede
// veículo / ano / motor pra conferir a aplicação antes de despachar. Funciona — nas
// conversas antigas aparece "MARAVILHA, obrigada pela confirmação!! Você comprou
// certinho". Evita a devolução por "não serve no meu carro", que é o motivo campeão.
//
// TRAVAS
//   • o texto vem pronto da fila, não é montado aqui: dá pra conferir antes de sair
//   • uma mensagem por pedido — a fila já não repete pedido que tem tarefa
//   • depois de enviar, CONFERE pela API que a mensagem está lá
//   • se a conversa já tiver mensagem, não manda (alguém falou antes)

const PAINEL_VENDA = (pack) => `https://www.mercadolivre.com.br/vendas/${pack}/detalhe`;
const ESPERA_CURTA = 1500;

// A conversa pela API oficial — nossa fonte de verdade, não a tela.
async function conversaDoPedido(pack, seller, accessToken) {
  const r = await fetch(
    `https://api.mercadolibre.com/messages/packs/${pack}/sellers/${seller}?tag=post_sale&mark_as_read=false`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) return { erro: `não consegui ler a conversa (HTTP ${r.status})` };
  const d = await r.json();
  return { total: d?.paging?.total ?? (d?.messages || []).length, status: d?.conversation_status?.status ?? null };
}

async function enviarMensagem(navegador, pagina, tarefa, accessToken, deps) {
  const { log, sellerDaConta } = deps;
  const p = tarefa.params || {};
  if (!p.pack_id || !p.texto) throw new Error('tarefa sem pack_id ou texto');

  const seller = await sellerDaConta(tarefa.conta);

  // Alguém já falou com esse comprador? Então não começamos conversa nenhuma.
  const antes = await conversaDoPedido(p.pack_id, seller, accessToken);
  if (antes.erro) throw new Error(antes.erro);
  if (antes.total > 0) {
    return { ok: true, nada_a_fazer: true, motivo: 'a conversa já tinha mensagem' };
  }

  await pagina.goto(PAINEL_VENDA(p.pack_id), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pagina.waitForTimeout(ESPERA_CURTA);

  // O painel chama de "Iniciar conversa" quando ninguém falou ainda.
  const botao = pagina.locator(
    'text=/iniciar conversa/i, [data-testid*="start-conversation"], button:has-text("Iniciar conversa")',
  ).first();
  if (!(await botao.count())) {
    return { ok: false, observacao: 'não achei o botão de iniciar conversa nesta venda' };
  }
  await botao.click();
  await pagina.waitForTimeout(ESPERA_CURTA);

  const campo = pagina.locator('textarea, [contenteditable="true"]').first();
  if (!(await campo.count())) {
    return { ok: false, observacao: 'a caixa de mensagem não abriu' };
  }
  await campo.click();
  // Digita em vez de colar: campo do painel costuma ignorar valor setado por fora.
  await campo.fill(p.texto);
  await pagina.waitForTimeout(600);

  const enviar = pagina.locator('button:has-text("Enviar"), [data-testid*="send"]').first();
  if (!(await enviar.count())) {
    return { ok: false, observacao: 'não achei o botão de enviar' };
  }
  await enviar.click();
  await pagina.waitForTimeout(3000);

  // NÃO ACREDITA NA PRÓPRIA AÇÃO: confere pela API que a mensagem chegou.
  let depois = null;
  for (let i = 1; i <= 3; i++) {
    depois = await conversaDoPedido(p.pack_id, seller, accessToken);
    if (!depois.erro && depois.total > 0) break;
    await pagina.waitForTimeout(i * 2000);
  }
  if (!depois || depois.erro || !(depois.total > 0)) {
    return { ok: false, observacao: 'cliquei em enviar mas a mensagem não apareceu na conversa' };
  }

  log(`  ${tarefa.conta}: mensagem enviada para ${p.nome} (pedido ${p.order_id})`);
  return {
    ok: true,
    nome: p.nome,
    pack_id: p.pack_id,
    titulo: p.item_title,
    mensagens_na_conversa: depois.total,
  };
}

module.exports = { enviarMensagem, conversaDoPedido };
