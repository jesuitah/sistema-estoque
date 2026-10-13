// Manda a mensagem de confirmação de aplicação ao comprador, pelo painel.
//
// POR QUE PELO PAINEL E NÃO PELA API PÚBLICA
// A API do Mercado Livre RECUSA o vendedor iniciar conversa:
//     403 blocked_by_conversation_initiated_by_seller_limited
// Medido em 06/10/2026: 17 de 30 pedidos das últimas 48h da KMP. Não é erro nosso,
// é política deles. No painel a ação existe — então essa é a única porta, igual à
// embalagem de fábrica.
//
// COMO FUNCIONA
// Reproduz exatamente a chamada que o painel faz quando a Letícia manda a mensagem
// (capturada com robo/gravar.js em 13/10/2026, com ela operando na mão):
//
//    POST /api/messages/action-guide/<pack>/option/OTHER?timezone=-0300
//         {"text": "...", "templateId": null}
//         header x-csrf-token
//
// Não imita cliques. A primeira versão caçava botão na tela e quebrou quatro vezes
// seguidas — o link não era <button>, havia um passo de "escolha uma mensagem da
// lista", a lista mudava de pedido pra pedido, e o botão de enviar nunca aparecia no
// seletor. Disparar a requisição da própria página resolve tudo isso de uma vez e não
// quebra quando o layout muda.
//
// O QUE A MENSAGEM FAZ
// É a mesma que a Letícia manda em toda venda que não é Full: pede veículo / ano /
// motor pra conferir a aplicação antes de despachar. Funciona — nas conversas aparece
// "MARAVILHA, obrigada pela confirmação!! Você comprou certinho". Evita a devolução
// por "não serve no meu carro", que é o motivo campeão nas 3 lojas.
//
// TRAVAS
//   • o texto vem pronto da fila, não é montado aqui: dá pra conferir antes de sair
//   • se a conversa já tiver mensagem, não manda (alguém falou antes)
//   • depois de enviar, CONFERE pela API oficial que a mensagem está lá
//   • sem csrf, para na hora — não chuta

const PAINEL_MENSAGENS = (pack) =>
  `https://vendedores.mercadolivre.com.br/vendas/novo/mensagens/${pack}`;
const ENVIO = (pack) =>
  `https://vendedores.mercadolivre.com.br/api/messages/action-guide/${pack}/option/OTHER?timezone=-0300`;

// A conversa pela API oficial — nossa fonte de verdade, não a tela.
async function conversaDoPedido(pack, seller, accessToken) {
  const r = await fetch(
    `https://api.mercadolibre.com/messages/packs/${pack}/sellers/${seller}?tag=post_sale&mark_as_read=false`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!r.ok) return { erro: `não consegui ler a conversa (HTTP ${r.status})` };
  const d = await r.json();
  return {
    total: d?.paging?.total ?? (d?.messages || []).length,
    status: d?.conversation_status?.status ?? null,
    substatus: d?.conversation_status?.substatus ?? null,
  };
}

async function lerCsrf(pagina) {
  return pagina.evaluate(() => {
    const m = document.querySelector('meta[name*=csrf i], meta[name*=xsrf i]');
    return m ? m.getAttribute('content') : null;
  });
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
  // Depois que a encomenda é entregue o ML fecha a conversa do lado do vendedor.
  // Não é falha: é o fim da janela, e a tarefa não tem mais como dar certo.
  if (antes.substatus && /contact_closed|initiated_by_seller_limited/i.test(antes.substatus)) {
    return {
      ok: true, nada_a_fazer: true,
      motivo: 'o Mercado Livre não aceita mais iniciar conversa neste pedido',
    };
  }

  // Abre a página de mensagens só pra ter sessão e csrf válidos na mesma origem.
  await pagina.goto(PAINEL_MENSAGENS(p.pack_id), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pagina.waitForTimeout(2500);

  const csrf = await lerCsrf(pagina);
  if (!csrf) throw new Error('não achei o x-csrf-token na página — não vou chutar');

  const envio = await pagina.evaluate(async ({ url, csrf, texto }) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrf,
        Accept: 'application/json, text/plain, */*',
      },
      body: JSON.stringify({ text: texto, templateId: null }),
      credentials: 'include',
    });
    let corpo = null;
    try { corpo = await r.text(); } catch (_e) { /* resposta sem corpo */ }
    return { status: r.status, corpo: (corpo || '').slice(0, 300) };
  }, { url: ENVIO(p.pack_id), csrf, texto: p.texto });

  if (envio.status !== 200) {
    return {
      ok: false,
      observacao: `o Mercado Livre recusou o envio (HTTP ${envio.status})`,
      detalhe: envio.corpo,
    };
  }

  // NÃO ACREDITA NA PRÓPRIA AÇÃO: confere pela API oficial que a mensagem chegou.
  let depois = null;
  for (let i = 1; i <= 4; i++) {
    depois = await conversaDoPedido(p.pack_id, seller, accessToken);
    if (!depois.erro && depois.total > 0) break;
    await pagina.waitForTimeout(i * 2000);
  }
  if (!depois || depois.erro || !(depois.total > 0)) {
    return { ok: false, observacao: 'o envio respondeu 200 mas a mensagem não apareceu na conversa' };
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
