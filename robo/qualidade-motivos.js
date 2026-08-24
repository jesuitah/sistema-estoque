// Por que os anúncios não estão com nota máxima?
//
// Como usar:   node qualidade-motivos.js
//
// Leitura pura pela API. Compara os atributos que cada anúncio TEM com os que a
// categoria dele PEDE, e conta o que mais falta no conjunto todo. Assim sabemos o
// que consertar primeiro — e se dá pra consertar por API (atributo) ou se exige
// trabalho humano (foto, vídeo, descrição).

const fs = require('fs');
const path = require('path');

const ARQUIVO_TOKENS = path.join(__dirname, '.tokens.json');
const AMOSTRA_POR_CONTA = 120; // suficiente pra enxergar o padrão sem varrer tudo

const cacheCategoria = new Map();

async function atributosDaCategoria(categoriaId, token) {
  if (cacheCategoria.has(categoriaId)) return cacheCategoria.get(categoriaId);
  const r = await fetch(`https://api.mercadolibre.com/categories/${categoriaId}/attributes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = r.ok ? await r.json() : [];
  const lista = Array.isArray(j) ? j : [];
  cacheCategoria.set(categoriaId, lista);
  return lista;
}

async function main() {
  const contas = JSON.parse(fs.readFileSync(ARQUIVO_TOKENS, 'utf8'));

  const faltando = {};   // id do atributo -> quantas vezes faltou
  const nomes = {};      // id -> nome legível
  const porTipo = { obrigatorio: 0, recomendado: 0 };
  let poucasFotos = 0, semFicha = 0, analisados = 0;
  const exemplos = [];

  for (const c of contas) {
    const arq = path.join(__dirname, 'prints', `qualidade-${c.conta}.json`);
    if (!fs.existsSync(arq)) { console.log(`  (falta ${path.basename(arq)} — rode qualidade.js antes)`); continue; }
    const itens = JSON.parse(fs.readFileSync(arq, 'utf8'))
      .filter((i) => typeof i.health === 'number')
      .slice(0, AMOSTRA_POR_CONTA);

    console.log(`  ${c.conta}: analisando ${itens.length} anúncios abaixo do máximo...`);

    for (const item of itens) {
      analisados++;
      const daCategoria = await atributosDaCategoria(item.category_id, c.access_token);
      const preenchidos = new Set(
        (item.attributes || [])
          .filter((a) => a.value_name || a.value_id)
          .map((a) => a.id)
      );

      const ausentes = daCategoria.filter((a) => {
        const exigido = a.tags?.required || a.tags?.catalog_required;
        const sugerido = a.tags?.conditional_required || a.relevance === 1;
        if (a.tags?.read_only || a.tags?.hidden) return false;
        if (!exigido && !sugerido) return false;
        return !preenchidos.has(a.id);
      });

      ausentes.forEach((a) => {
        faltando[a.id] = (faltando[a.id] || 0) + 1;
        nomes[a.id] = a.name;
        if (a.tags?.required || a.tags?.catalog_required) porTipo.obrigatorio++;
        else porTipo.recomendado++;
      });

      if ((item.pictures || []).length < 5) poucasFotos++;
      if ((item.attributes || []).length < 8) semFicha++;

      if (exemplos.length < 5 && ausentes.length) {
        exemplos.push({
          nota: item.health,
          titulo: String(item.title).slice(0, 50),
          falta: ausentes.slice(0, 6).map((a) => a.name),
        });
      }
    }
  }

  console.log('');
  console.log('  ' + '═'.repeat(58));
  console.log(`  ${analisados} anúncios analisados`);
  console.log('');
  console.log('  ATRIBUTOS QUE MAIS FALTAM:');
  Object.entries(faltando)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([id, n]) => {
      const pct = Math.round((n / analisados) * 100);
      console.log(`    ${String(n).padStart(4)} (${String(pct).padStart(3)}%)  ${nomes[id]}  [${id}]`);
    });

  console.log('');
  console.log(`  anúncios com menos de 5 fotos : ${poucasFotos}`);
  console.log(`  anúncios com ficha rasa (<8 atributos): ${semFicha}`);
  console.log('');
  console.log('  EXEMPLOS:');
  exemplos.forEach((e) => {
    console.log(`    nota ${e.nota} — ${e.titulo}`);
    console.log(`      falta: ${e.falta.join(', ')}`);
  });
  console.log('');
}

main().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
