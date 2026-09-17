// Guia dos avisos — o que cada problema significa e como resolver SEM precisar do Claude.
//
// Pedido do Matheus (17/09/2026): "toda vez que acontece eu não sei o que aconteceu e
// tenho que vir falar com você... o ideal seria eu conseguir resolver sozinho, e só
// falar com você em casos extremos".
//
// Cada aviso ganha três coisas, mostradas na tarja ao clicar em "Como resolver":
//   explicacao   o que aconteceu, em português de gente
//   o_que_fazer  o passo a passo — ou "nada, o robô resolve sozinho"
//   acoes        botões: tentar_de_novo (volta tarefas pra fila), abrir (link),
//                liberar_sessao (a loja voltou a ter login)
//
// Quando uma causa nova aparecer, é AQUI que se ensina o sistema a explicá-la.

const NOME_TAREFA = {
  ligar_flex: 'ligar o Envios Flex',
  desligar_flex: 'desligar o Envios Flex',
  tirar_do_full: 'tirar o anúncio do Full',
};

const editar = (itemId) => `https://www.mercadolivre.com.br/anuncios/${itemId}/modificar/`;

// Traduz o erro de UMA tarefa numa causa conhecida.
function causaDaFalha(tipo, erro, motivo) {
  const t = `${erro || ''} ${motivo || ''}`;
  if (/não mostra o Flex|ainda mostra o Flex|confirmar o resultado/i.test(t) && /flex/i.test(tipo)) {
    return {
      explicacao: 'O robô marcou a caixinha do Flex e confirmou, mas o Mercado Livre não aceitou a mudança. ' +
        'Costuma acontecer com anúncio que está no Full ou com pouquíssima unidade — o ML decide sozinho se aquele anúncio pode ter Flex.',
      o_que_fazer: '1) Aperte "Tentar de novo". 2) Se falhar outra vez, abra o anúncio e tente mexer no Flex você mesmo. ' +
        '3) Se nem pelo painel o ML deixar, esse anúncio não aceita Flex agora: é só fechar o aviso (×).',
      retentar: true,
    };
  }
  if (/caixinha.*bloqueada|não aceita Envios Flex/i.test(t)) {
    return {
      explicacao: 'Esse anúncio não tem a opção de Envios Flex liberada pelo Mercado Livre.',
      o_que_fazer: 'Não tem o que fazer pelo sistema. Feche o aviso (×).',
      retentar: false,
    };
  }
  if (/não achei a caixinha/i.test(t)) {
    return {
      explicacao: 'A página do anúncio abriu, mas a opção de Envios Flex não apareceu. Pode ser página que não carregou direito, ou anúncio sem Flex.',
      o_que_fazer: '1) Aperte "Tentar de novo". 2) Se falhar outra vez, abra o anúncio: se não houver a opção Flex, feche o aviso (×).',
      retentar: true,
    };
  }
  if (/navegador|fechou|demorou|não carregou|timeout|Failed to fetch|Execution context/i.test(t)) {
    return {
      explicacao: 'O Mercado Livre demorou pra responder ou o navegador do robô fechou no meio. É passageiro.',
      o_que_fazer: 'Aperte "Tentar de novo". Se falhar várias vezes seguidas, aí sim fale com o Claude.',
      retentar: true,
    };
  }
  if (/recusou|HTTP 4/i.test(t)) {
    return {
      explicacao: `O Mercado Livre recusou ${NOME_TAREFA[tipo] || 'a operação'} nesse anúncio.`,
      o_que_fazer: 'Abra o anúncio e veja se ele está em revisão, encerrado ou com algum aviso do ML. Se estiver tudo normal, aperte "Tentar de novo".',
      retentar: true,
    };
  }
  return {
    explicacao: `O robô não conseguiu ${NOME_TAREFA[tipo] || 'terminar a tarefa'}. Motivo informado: ${(erro || motivo || 'não informado').slice(0, 160)}.`,
    o_que_fazer: 'Aperte "Tentar de novo". Se voltar a falhar, fale com o Claude — é uma causa que o sistema ainda não conhece.',
    retentar: true,
  };
}

// Aviso de tarefas que falharam: um por loja + tipo, com os anúncios envolvidos.
function guiaTarefasFalhas(conta, tipo, falhas) {
  const causa = causaDaFalha(tipo, falhas[0].erro, falhas[0].resultado?.motivo);
  const acoes = [];
  if (causa.retentar) acoes.push({ tipo: 'tentar_de_novo', rotulo: '🔁 Tentar de novo', tarefas: falhas.map((f) => f.id) });
  for (const f of falhas.slice(0, 5)) {
    const item = f.params?.item_id;
    if (item) acoes.push({ tipo: 'abrir', rotulo: `Abrir ${item} no ML`, url: editar(item) });
  }
  const qtd = falhas.length;
  return {
    mensagem: `${conta}: não deu pra ${NOME_TAREFA[tipo] || tipo} em ${qtd} anúncio(s)`,
    explicacao: causa.explicacao,
    o_que_fazer: causa.o_que_fazer,
    acoes,
  };
}

// Guia dos demais avisos, pela chave.
function guiaPorChave(chave) {
  const [tipo, conta] = chave.split(':');
  const guias = {
    sessao_caida: {
      explicacao: `O Chrome do robô perdeu o login da ${conta} no Mercado Livre. Enquanto isso, as tarefas dessa loja que usam o navegador (Flex, tirar do Full) ficam esperando — as outras lojas seguem normais.`,
      o_que_fazer: `No PC do robô: abra o Prompt de Comando, digite  cd Downloads\\sistema-estoque-real\\robo  e depois  npm run login -- ${conta} . Vai abrir um Chrome: entre na conta ${conta} e feche. Depois aperte "Já entrei de novo".`,
      acoes: [{ tipo: 'liberar_sessao', rotulo: '✅ Já entrei de novo', conta }],
    },
    sem_estoque_full: {
      explicacao: `Tem anúncio da ${conta} sem estoque parado no Full, e o robô não conseguiu tirar sozinho.`,
      o_que_fazer: 'O robô tenta de novo na próxima patrulha (de hora em hora). Se o aviso continuar por mais de um dia, fale com o Claude.',
      acoes: [],
    },
    sku_desconhecido: {
      explicacao: `Existem anúncios da ${conta} com um SKU que não está cadastrado no estoque. O sistema não sabe se há peça, então não mexe neles.`,
      o_que_fazer: 'Se é de propósito (anúncio antigo, linha que não trabalhamos mais), feche o aviso (×). Se não, cadastre o SKU na aba Busca.',
      acoes: [],
    },
    patrulha_erro: {
      explicacao: `A última patrulha da ${conta} deu erro no meio.`,
      o_que_fazer: 'Nada por enquanto: a patrulha roda de novo em até 1 hora. Se o aviso continuar depois de 2 patrulhas, fale com o Claude.',
      acoes: [],
    },
    patrulha_travada: {
      explicacao: `Alguns anúncios da ${conta} que estavam fora de venda não voltaram mesmo com o robô tentando.`,
      o_que_fazer: 'Nada: o robô continua tentando sozinho. Pode fechar o aviso (×) — ele volta se a quantidade mudar.',
      acoes: [],
    },
    verificacao_sem_estoque: {
      explicacao: 'O robô não conseguiu consultar a lista de anúncios sem estoque no Mercado Livre desta vez.',
      o_que_fazer: 'Nada: ele tenta de novo em 15 minutos. Só fale com o Claude se ficar assim por horas.',
      acoes: [],
    },
    frete_faltando: {
      explicacao: 'Alguns anúncios em promoção estão sem o valor de frete, então o "Você recebe" deles aparece maior do que é.',
      o_que_fazer: 'Nada urgente: a próxima leitura de promoções completa. Se passar de 2 dias, fale com o Claude.',
      acoes: [],
    },
    tarifa_faltando: {
      explicacao: 'Alguns anúncios em promoção estão sem categoria, então o sistema não sabe a tarifa do ML deles.',
      o_que_fazer: 'Nada urgente: a próxima leitura de promoções completa. Se passar de 2 dias, fale com o Claude.',
      acoes: [],
    },
    frete_parado: {
      explicacao: 'O custo de frete das vendas não é atualizado há alguns dias.',
      o_que_fazer: 'Rode "Rodar tudo" no app ou atualize as promoções. Se continuar, fale com o Claude.',
      acoes: [],
    },
    frete_verificacao: {
      explicacao: 'O robô não conseguiu conferir o custo de frete desta vez.',
      o_que_fazer: 'Nada: ele tenta de novo em 15 minutos.',
      acoes: [],
    },
    flex_caiu_sozinho: {
      explicacao: 'Na última semana, alguns anúncios ativos perderam o Envios Flex sem o sistema ter pedido — foi o próprio Mercado Livre ou alguém pelo painel.',
      o_que_fazer: 'Use a aba Anúncios → Chegou peça pra religar o Flex dos que têm estoque. Depois feche o aviso (×).',
      acoes: [],
    },
  };
  return guias[tipo] || {
    explicacao: 'Aviso sem explicação cadastrada ainda.',
    o_que_fazer: 'Se ele continuar aparecendo, fale com o Claude pra ensinar o sistema a explicar este caso.',
    acoes: [],
  };
}

module.exports = { guiaTarefasFalhas, guiaPorChave, causaDaFalha };
