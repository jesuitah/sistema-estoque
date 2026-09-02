// Confere, anúncio por anúncio no Mercado Livre, se a cópia de campanha realmente valeu.
//
// NÃO confia no "0 recusados" da chamada: pergunta ao ML o estado de cada anúncio e
// compara o percentual real com o que a origem tinha. HTTP 200 já mentiu neste projeto.
//
// Como usar:  node conferir-copia.js KMP AGOSTO SETEMBRO

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function conectar() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chave = html.match(/supabaseKey\s*=\s*['"]([^'"]+)['"]/)[1];
  return createClient('https://pylkufhziohxvwbbaued.supabase.co', chave);
}

const pctDe = (cheio, preco) => Math.round((1 - Number(preco) / Number(cheio)) * 1000) / 10;

async function carregar(sb, conta) {
  let todos = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await sb.from('ml_promocoes_itens').select('*')
      .eq('conta', conta).order('item_id').range(i, i + 999);
    if (!data || !data.length) break;
    todos = todos.concat(data);
    if (data.length < 1000) break;
  }
  return todos;
}

async function main() {
  const conta = (process.argv[2] || 'KMP').toUpperCase();
  const nomeOrigem = (process.argv[3] || 'AGOSTO').toUpperCase();
  const nomeDestino = (process.argv[4] || 'SETEMBRO').toUpperCase();
  const sb = conectar();

  const { data: tok } = await sb.from('ml_tokens')
    .select('access_token').eq('conta', conta).maybeSingle();
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const linhas = await carregar(sb, conta);
  const origem = linhas.filter((l) => (l.promocao_nome || '').toUpperCase() === nomeOrigem && l.status === 'started');
  const destino = linhas.find((l) => (l.promocao_nome || '').toUpperCase() === nomeDestino);
  const destinoId = destino.promocao_id;

  console.log(`\n  ${conta}: conferindo ${origem.length} anúncios da ${nomeOrigem} no ${nomeDestino}`);
  console.log('  (perguntando ao Mercado Livre um por um, sem usar o cache)\n');

  let certos = 0, fora = 0, diferentes = 0, naoConferidos = 0;
  const problemas = [];
  const semResposta = [];

  // "Não consegui perguntar" NÃO é "não está na promoção".
  //
  // O ML devolve 500 de vez em quando, ainda mais depois de muitas chamadas seguidas.
  // Antes isso entrava na conta de "fora da promoção" e o relatório acusava anúncios
  // sem desconto que estavam perfeitos. Agora tenta de novo e, se ainda assim não
  // responder, aparece numa lista à parte — o relatório diz "não sei", não "está fora".
  async function perguntar(itemId) {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const r = await fetch(
        `https://api.mercadolibre.com/seller-promotions/items/${itemId}?app_version=v2`,
        { headers: auth }).catch(() => null);
      if (r && r.ok) return await r.json();
      if (r && r.status >= 400 && r.status < 500) return null;   // erro nosso, não adianta insistir
      await new Promise((espera) => setTimeout(espera, tentativa * 1500));
    }
    return undefined;   // não conseguimos saber
  }

  for (let i = 0; i < origem.length; i++) {
    const o = origem[i];
    const esperado = pctDe(o.preco_cheio, o.preco_promo);
    try {
      const lista = await perguntar(o.item_id);
      if (lista === undefined) { semResposta.push(o); naoConferidos++; continue; }
      if (lista === null) { problemas.push({ o, motivo: 'o ML recusou a consulta' }); fora++; continue; }
      const noDestino = lista.find((p) => p.id === destinoId && p.status === 'started');
      if (!noDestino) {
        problemas.push({ o, esperado, motivo: `NÃO está na ${nomeDestino}` });
        fora++;
        continue;
      }
      const real = pctDe(noDestino.original_price, noDestino.price);
      // Meio ponto de folga: o preço é arredondado ao centavo, então 8% pode virar 8,0.
      if (Math.abs(real - esperado) > 0.5) {
        problemas.push({ o, esperado, real, motivo: `está com ${real}% em vez de ${esperado}%` });
        diferentes++;
      } else {
        certos++;
      }
    } catch (e) {
      problemas.push({ o, motivo: e.message });
      fora++;
    }

    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${origem.length}...`);
  }

  console.log(`\n  ── resultado ───────────────────────────`);
  console.log(`  certos ................ ${certos}`);
  console.log(`  fora da ${nomeDestino.padEnd(13)} ${fora}`);
  console.log(`  com % diferente ....... ${diferentes}`);
  if (naoConferidos) {
    console.log(`  NÃO CONFERIDOS ........ ${naoConferidos}  (o ML não respondeu — não sabemos, tente de novo)`);
    semResposta.slice(0, 10).forEach((o) => {
      console.log(`     ${(o.title || o.item_id).slice(0, 44)}`);
    });
  }
  if (problemas.length) {
    console.log('');
    problemas.slice(0, 30).forEach((p) => {
      console.log(`     ${(p.o.title || p.o.item_id).slice(0, 44).padEnd(46)}${p.motivo}`);
    });
    if (problemas.length > 30) console.log(`     ... e mais ${problemas.length - 30}`);
  }
  console.log('');
  process.exit(problemas.length || naoConferidos ? 1 : 0);
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(2); });
