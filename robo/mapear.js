// Mapeamento da Central de Vendedores — ESTRITAMENTE SOMENTE LEITURA.
//
// Como usar:   node mapear.js            (usa a conta KMP por padrão)
//              node mapear.js LTS
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ REGRA ABSOLUTA DESTE ARQUIVO: ele NÃO CONTÉM NENHUM CLIQUE.              │
// │ Só existem duas operações aqui: navegar até um endereço (goto) e ler o   │
// │ conteúdo da página (evaluate). Nada é selecionado, expandido, marcado    │
// │ ou acionado.                                                            │
// │                                                                          │
// │ Motivo: uma versão anterior tentava "expandir menus" clicando em botões  │
// │ sem rótulo. Não chegou a rodar, mas poderia ter acionado ação real numa  │
// │ loja de verdade. Não se repete: se um dado só existir atrás de um        │
// │ clique, este script REPORTA que existe e não clica.                      │
// │                                                                          │
// │ Para conferir:  grep -n "click" mapear.js   →  não deve achar nada.      │
// └──────────────────────────────────────────────────────────────────────────┘

const fs = require('fs');
const path = require('path');
const { abrirNavegador, validarConta, sessaoExiste, identificarConta } = require('./navegador');

const PONTO_DE_PARTIDA = 'https://vendedores.mercadolivre.com.br/anuncios';

// Endereços já descobertos em explorações anteriores. Outros são achados sozinhos,
// lendo os links da própria página.
const CONHECIDOS = [
  ['Anúncios (lista)',            'https://vendedores.mercadolivre.com.br/anuncios/lista'],
  ['Full — gestão de estoque',    'https://vendedores.mercadolivre.com.br/anuncios/lista/space_management'],
  ['Full — envios (inbounds)',    'https://vendedores.mercadolivre.com.br/shipping/inbounds'],
  ['Full — retiradas',            'https://vendedores.mercadolivre.com.br/fulfillment/withdrawals'],
  ['Full — espaço/cota',          'https://vendedores.mercadolivre.com.br/metricas/stock-full'],
  ['Promoções',                   'https://vendedores.mercadolivre.com.br/metricas/beneficios'],
  ['Afiliados — campanhas',       'https://vendedores.mercadolivre.com.br/seller-affiliates/campaign'],
  ['Afiliados — métricas',        'https://vendedores.mercadolivre.com.br/seller-affiliates/dashboard'],
  ['Afiliados — pedidos',         'https://vendedores.mercadolivre.com.br/seller-affiliates/orders'],
];

const ESPERA_APOS_CARREGAR = 8000; // essas telas montam os dados por JavaScript

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Lê tudo o que interessa de uma página já aberta. Puramente leitura.
async function lerPagina(pagina) {
  return pagina.evaluate(() => {
    const limpar = (s) => (s || '').trim().replace(/\s+/g, ' ');

    const botoes = [];
    document.querySelectorAll('button, [role="button"]').forEach((b) => {
      const t = limpar(b.innerText || b.getAttribute('aria-label'));
      if (t && t.length < 60) botoes.push(t);
    });

    const abas = [];
    document.querySelectorAll('[role="tab"]').forEach((t) => {
      const texto = limpar(t.innerText);
      if (texto) abas.push({ texto, selecionada: t.getAttribute('aria-selected') === 'true' });
    });

    const links = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const texto = limpar(a.innerText || a.getAttribute('aria-label'));
      const href = a.href.split('#')[0];
      if (!texto || texto.length > 55) return;
      if (!/mercadolivre\.com|mercadolibre\.com/.test(href)) return;
      if (/item_id=|itemId=|\/MLB\d/.test(href)) return; // links por-produto poluem
      links.push({ texto, href });
    });

    // Alguns painéis de aba já vêm no HTML mesmo sem estarem visíveis —
    // dá pra ler o rótulo deles sem precisar clicar em nada.
    const paineisOcultos = [];
    document.querySelectorAll('[role="tabpanel"]').forEach((p) => {
      const t = limpar(p.innerText).slice(0, 200);
      if (t) paineisOcultos.push(t);
    });

    return {
      titulo: document.title,
      texto: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n'),
      botoes: [...new Set(botoes)],
      abas,
      links,
      paineisOcultos,
    };
  });
}

function resumirTexto(texto, limite = 40) {
  return texto.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, limite);
}

async function main() {
  const conta = validarConta(process.argv[2] || 'KMP');
  if (!sessaoExiste(conta)) throw new Error(`Sem sessão salva para ${conta}.`);

  const navegador = await abrirNavegador(conta);
  const pagina = navegador.pages()[0] || (await navegador.newPage());
  const identidade = await identificarConta(navegador);

  console.log('');
  console.log(`  MAPEAMENTO (somente leitura) — ${conta} / ${identidade.apelido}`);
  console.log('  ' + '═'.repeat(60));

  // 1) Descobre endereços lendo os links do painel — sem expandir nada
  await pagina.goto(PONTO_DE_PARTIDA, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await pagina.waitForTimeout(ESPERA_APOS_CARREGAR);
  const inicial = await lerPagina(pagina);

  const descobertos = new Map();
  CONHECIDOS.forEach(([nome, url]) => descobertos.set(url, nome));
  inicial.links.forEach((l) => {
    if (!descobertos.has(l.href)) descobertos.set(l.href, l.texto);
  });

  console.log(`  Endereços a visitar: ${descobertos.size}`);
  console.log('');

  const relatorio = { conta, apelido: identidade.apelido, gerado_em: new Date().toISOString(), paginas: [] };

  for (const [url, nome] of descobertos) {
    let dados;
    try {
      await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pagina.waitForTimeout(ESPERA_APOS_CARREGAR);
      dados = await lerPagina(pagina);
    } catch (erro) {
      console.log(`  ✗ ${nome}  (não abriu: ${erro.message.split('\n')[0].slice(0, 50)})`);
      relatorio.paginas.push({ nome, url, erro: erro.message });
      continue;
    }

    const urlFinal = pagina.url();
    console.log(`  ▸ ${nome}`);
    console.log(`    ${urlFinal}`);
    console.log(`    título: "${dados.titulo}"`);
    if (dados.abas.length) {
      console.log(`    abas: ${dados.abas.map((a) => a.texto + (a.selecionada ? ' (aberta)' : '')).join(' | ')}`);
    }
    const acoes = dados.botoes.filter((b) =>
      /retirar|descartar|oferecer|reativar|pausar|ativar|enviar|criar|editar|baixar|gerar|aplicar|programar|excluir/i.test(b)
    );
    if (acoes.length) console.log(`    ações disponíveis: ${acoes.slice(0, 12).join(' · ')}`);
    console.log('');

    const arquivo = `mapa-${conta}-${nome.replace(/[^\w]+/g, '_').slice(0, 40)}`;
    await pagina.screenshot({ path: path.join(__dirname, 'prints', `${arquivo}.png`), fullPage: false }).catch(() => {});
    fs.writeFileSync(path.join(__dirname, 'prints', `${arquivo}.txt`), dados.texto);

    relatorio.paginas.push({
      nome, url, urlFinal,
      titulo: dados.titulo,
      abas: dados.abas,
      botoes: dados.botoes,
      acoes,
      resumo: resumirTexto(dados.texto),
    });
  }

  fs.writeFileSync(
    path.join(__dirname, 'prints', `MAPA-${conta}-${carimbo()}.json`),
    JSON.stringify(relatorio, null, 2)
  );

  console.log('  ' + '═'.repeat(60));
  console.log(`  ${relatorio.paginas.length} páginas mapeadas. Detalhes em robo/prints/MAPA-${conta}-*.json`);
  console.log('');

  await navegador.close().catch(() => {});
}

main().catch((erro) => {
  console.error('');
  console.error('  ❌ Erro:', erro.message);
  process.exit(1);
});
