// Editor de anúncio — alterar pelo sistema o que hoje se faz no painel do Mercado Livre.
//
// Pedido do Matheus (16/09/2026): "realizar as alterações diretamente no sistema e não
// na plataforma do mercado livre" — tudo o que a API permite. Ficam de fora só o que
// ela NÃO permite: clip (só pelo app do ML) e Flex (só o robô, clicando no painel).
//
// Ações (POST { acao, conta, item_id, ... }):
//   ler                  tudo o que o editor mostra, direto do ML (nada de cache)
//   atributos            grava características  [{id, value_id?, value_name?, values?}]
//   fotos                grava a lista final de fotos, na ordem  {ids: [picture_id]}
//   foto_upload          multipart (campo file) ?conta= — devolve {picture_id}
//   preco                {preco}
//   frete_gratis         {ligado}
//   tipo_anuncio         {tipo}  gold_special = Clássico · gold_pro = Premium
//   ads                  {ligado, campaign_id?}
//   compat_marcas        lista de marcas de carro
//   compat_valores       {atributo: MODEL|VEHICLE_YEAR, conhecidos: [{id, value_id}]}
//   compat_buscar        {conhecidos} — versões de veículo que batem
//   compat_adicionar     {ids: [catalog_product_id]}
//   compat_copiar        {de_item} — copia a compatibilidade de outro anúncio nosso
//   compat_remover       {ids: [id da compatibilidade]}
//
// Cada alteração vai pro histórico (ml_log_acoes) e é CONFERIDA no ML depois — um 200
// do Mercado Livre já mentiu neste projeto.

import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
const API = "https://api.mercadolibre.com";
const DOMINIO_CARROS = "MLB-CARS_AND_VANS";

async function token(conta: string) {
  const { data } = await sb.from("ml_tokens").select("access_token, user_id").eq("conta", conta).maybeSingle();
  if (!data) throw new Error(`conta ${conta} sem token`);
  return { auth: `Bearer ${data.access_token}`, userId: data.user_id as string };
}

async function chamar(url: string, auth: string, opcoes: { method?: string; body?: unknown; extra?: Record<string, string> } = {}) {
  let ultima: { ok: boolean; status: number; dados: any } = { ok: false, status: 0, dados: null };
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(API + url, {
        method: opcoes.method ?? "GET",
        headers: { Authorization: auth, "Content-Type": "application/json", ...(opcoes.extra ?? {}) },
        body: opcoes.body === undefined ? undefined : JSON.stringify(opcoes.body),
      });
      const texto = await r.text();
      let dados: any = texto;
      try { dados = JSON.parse(texto); } catch (_e) { /* texto puro */ }
      ultima = { ok: r.ok, status: r.status, dados };
      if (r.ok || (r.status < 500 && r.status !== 429)) return ultima;
    } catch (_e) { /* tenta de novo */ }
    await new Promise((ok) => setTimeout(ok, 900 * (i + 1)));
  }
  return ultima;
}

function motivo(r: { status: number; dados: any }) {
  const d = r.dados ?? {};
  const partes = [d.message, ...((d.cause ?? []) as { message?: string }[]).map((c) => c.message)].filter(Boolean);
  return (partes.join(" · ") || `o Mercado Livre respondeu ${r.status}`).slice(0, 300);
}

async function registrar(conta: string, itemId: string, acao: string, detalhe: string, title?: string | null) {
  await sb.from("ml_log_acoes").insert({ conta, item_id: itemId, title: title ?? null, acao, origem: "site",
    detalhe: `editor — ${detalhe}`.slice(0, 300) }).then(() => {}, () => {});
}

const ADS = "/marketplace/advertising/MLB";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Upload de foto vem como multipart, não JSON.
    const url = new URL(req.url);
    if (url.searchParams.get("acao") === "foto_upload") {
      const conta = String(url.searchParams.get("conta") ?? "").toUpperCase();
      const t = await token(conta);
      const form = await req.formData();
      const arquivo = form.get("file");
      if (!arquivo) return json({ erro: "nenhum arquivo" }, 400);
      const envio = new FormData();
      envio.append("file", arquivo as File);
      const r = await fetch(`${API}/pictures/items/upload`, { method: "POST", headers: { Authorization: t.auth }, body: envio });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ ok: false, motivo: motivo({ status: r.status, dados: d }) });
      return json({ ok: true, picture_id: d.id, url: d.variations?.[0]?.secure_url ?? null });
    }

    const c = await req.json();
    const conta = String(c.conta ?? "").toUpperCase();
    if (!["KMP", "ERP", "LTS"].includes(conta)) return json({ erro: "loja inválida" }, 400);
    const t = await token(conta);
    const id = c.item_id as string;
    const PUT = (corpo: unknown) => chamar(`/items/${id}`, t.auth, { method: "PUT", body: corpo });

    switch (c.acao) {
      case "ler": {
        const [item, compat, ad, campanhas] = await Promise.all([
          chamar(`/items/${id}?include_attributes=all`, t.auth),
          chamar(`/items/${id}/compatibilities`, t.auth),
          chamar(`${ADS}/product_ads/ads/${id}`, t.auth, { extra: { "api-version": "2" } }),
          (async () => {
            const adv = await chamar(`/advertising/advertisers?product_id=PADS`, t.auth, { extra: { "api-version": "1" } });
            const advId = adv.dados?.advertisers?.[0]?.advertiser_id;
            if (!advId) return [];
            const r = await chamar(`${ADS}/advertisers/${advId}/product_ads/campaigns/search?limit=50`, t.auth, { extra: { "api-version": "2" } });
            return ((r.dados?.results ?? []) as { id: number; name: string; status: string }[])
              .map((x) => ({ id: x.id, nome: x.name, status: x.status }));
          })(),
        ]);
        if (!item.ok) return json({ erro: "não consegui ler o anúncio: " + motivo(item) }, 502);
        const i = item.dados;
        const categoria = await chamar(`/categories/${i.category_id}/attributes`, t.auth);
        const doItem = new Map(((i.attributes ?? []) as any[]).map((a) => [a.id, a]));
        const NAO = new Set(["SELLER_SKU", "GTIN", "ITEM_CONDITION", "EMPTY_GTIN_REASON"]);
        const caracteristicas = ((categoria.dados ?? []) as any[])
          .filter((a) => { const tg = a.tags ?? {}; return !tg.hidden && !tg.read_only && !tg.fixed && !NAO.has(a.id); })
          .map((a) => {
            const atual = doItem.get(a.id);
            return {
              id: a.id, nome: a.name, tipo: a.value_type, multivalor: !!(a.tags ?? {}).multivalued,
              obrigatorio: !!(a.tags ?? {}).required || !!(a.tags ?? {}).catalog_required,
              opcoes: (a.values ?? []).map((v: any) => ({ id: v.id, nome: v.name })),
              unidades: (a.allowed_units ?? []).map((u: any) => u.id), unidade_padrao: a.default_unit ?? null,
              nao_se_aplica: atual?.value_id === "-1",
              valor_id: atual?.value_id && atual.value_id !== "-1" ? atual.value_id : null,
              valor: atual?.value_id === "-1" ? null : (atual?.value_name ?? null),
              valores: ((atual?.values ?? []) as any[]).filter((v) => v.name).map((v) => v.name),
            };
          });
        const { data: promos } = await sb.from("ml_promocoes_itens")
          .select("promocao_id, promocao_tipo, promocao_nome, status, preco_cheio, preco_promo")
          .eq("conta", conta).eq("item_id", id);
        return json({
          item_id: id, titulo: i.title, status: i.status, categoria: i.category_id,
          preco: i.price, tipo_anuncio: i.listing_type_id,
          frete_gratis: !!i.shipping?.free_shipping, no_full: i.shipping?.logistic_type === "fulfillment",
          fotos: ((i.pictures ?? []) as any[]).map((p) => ({ id: p.id, url: p.secure_url })),
          caracteristicas,
          compatibilidade: ((compat.dados?.products ?? []) as any[]).map((p) => ({ id: p.id, produto: p.catalog_product_id, nome: p.catalog_product_name })),
          ads: ad.ok ? { status: ad.dados.status, campaign_id: ad.dados.campaign_id || null } : null,
          campanhas,
          promocoes: promos ?? [],
        });
      }

      case "atributos": {
        const atributos = ((c.atributos ?? []) as any[]).map((a) => {
          if (a.nao_se_aplica) return { id: a.id, value_id: "-1", value_name: null };
          if (a.values) return { id: a.id, values: a.values.filter(Boolean).map((n: string) => ({ name: n })) };
          if (a.value_id) return { id: a.id, value_id: a.value_id };
          return { id: a.id, value_name: a.value_name };
        });
        if (!atributos.length) return json({ erro: "nada pra gravar" }, 400);
        const r = await PUT({ attributes: atributos });
        if (!r.ok) { await registrar(conta, id, "falhou", "características: " + motivo(r)); return json({ ok: false, motivo: motivo(r) }); }
        const depois = await chamar(`/items/${id}?attributes=id,title,attributes`, t.auth);
        const gravou = new Map(((depois.dados?.attributes ?? []) as any[]).map((a) => [a.id, a]));
        const naoPegou = atributos.filter((a) => { const g = gravou.get(a.id); return !g || (!g.value_name && !g.value_id); }).map((a) => a.id);
        await registrar(conta, id, "ficha_tecnica", "características: " + atributos.map((a) => a.id).join(", "), depois.dados?.title);
        return json({ ok: !naoPegou.length, nao_pegou: naoPegou, motivo: naoPegou.length ? "o ML aceitou mas não gravou: " + naoPegou.join(", ") : undefined });
      }

      case "fotos": {
        const ids = (c.ids ?? []) as string[];
        if (!ids.length) return json({ erro: "o anúncio precisa de pelo menos uma foto" }, 400);
        const r = await PUT({ pictures: ids.map((x) => ({ id: x })) });
        if (!r.ok) { await registrar(conta, id, "falhou", "fotos: " + motivo(r)); return json({ ok: false, motivo: motivo(r) }); }
        await registrar(conta, id, "fotos", `fotos: ${ids.length} na nova ordem`, r.dados?.title);
        return json({ ok: true, fotos: ((r.dados?.pictures ?? []) as any[]).map((p) => ({ id: p.id, url: p.secure_url })) });
      }

      case "preco": {
        const preco = Math.round(Number(c.preco) * 100) / 100;
        if (!(preco > 0)) return json({ erro: "preço inválido" }, 400);
        const r = await PUT({ price: preco });
        if (!r.ok) { await registrar(conta, id, "falhou", "preço: " + motivo(r)); return json({ ok: false, motivo: motivo(r) }); }
        await registrar(conta, id, "preco", `preço: R$ ${preco.toFixed(2)}`, r.dados?.title);
        return json({ ok: Number(r.dados?.price) === preco, preco: r.dados?.price });
      }

      case "frete_gratis": {
        const r = await PUT({ shipping: { free_shipping: !!c.ligado } });
        if (!r.ok) { await registrar(conta, id, "falhou", "frete grátis: " + motivo(r)); return json({ ok: false, motivo: motivo(r) }); }
        const agora = !!r.dados?.shipping?.free_shipping;
        await registrar(conta, id, "frete", `frete grátis ${agora ? "ligado" : "desligado"}`, r.dados?.title);
        return json({ ok: agora === !!c.ligado, frete_gratis: agora,
          motivo: agora !== !!c.ligado ? "o ML aceitou mas manteve o frete como estava" : undefined });
      }

      case "tipo_anuncio": {
        const r = await chamar(`/items/${id}/listing_type`, t.auth, { method: "POST", body: { id: c.tipo } });
        if (!r.ok) { await registrar(conta, id, "falhou", "tipo de anúncio: " + motivo(r)); return json({ ok: false, motivo: motivo(r) }); }
        const depois = await chamar(`/items/${id}?attributes=id,title,listing_type_id`, t.auth);
        await registrar(conta, id, "tipo_anuncio", `tipo de anúncio: ${depois.dados?.listing_type_id}`, depois.dados?.title);
        return json({ ok: depois.dados?.listing_type_id === c.tipo, tipo_anuncio: depois.dados?.listing_type_id });
      }

      case "ads": {
        const corpo: Record<string, unknown> = { status: c.ligado ? "active" : "paused" };
        if (c.campaign_id) corpo.campaign_id = Number(c.campaign_id);
        const r = await chamar(`${ADS}/product_ads/ads/${id}`, t.auth, { method: "PUT", body: corpo, extra: { "api-version": "2" } });
        if (!r.ok) { await registrar(conta, id, "falhou", "Product Ads: " + motivo(r)); return json({ ok: false, motivo: motivo(r) }); }
        const depois = await chamar(`${ADS}/product_ads/ads/${id}`, t.auth, { extra: { "api-version": "2" } });
        await registrar(conta, id, "ads", `Product Ads: ${depois.dados?.status}`, depois.dados?.title);
        return json({ ok: (depois.dados?.status === "active") === !!c.ligado, ads: { status: depois.dados?.status, campaign_id: depois.dados?.campaign_id || null } });
      }

      case "compat_marcas": {
        const r = await chamar(`/catalog_domains/${DOMINIO_CARROS}/attributes/BRAND/top_values`, t.auth,
          { method: "POST", body: { known_attributes: [] } });
        return json({ valores: ((r.dados ?? []) as any[]).map((v) => ({ id: v.id, nome: v.name })).sort((a, b) => a.nome.localeCompare(b.nome)) });
      }

      case "compat_valores": {
        const r = await chamar(`/catalog_domains/${DOMINIO_CARROS}/attributes/${c.atributo}/top_values`, t.auth,
          { method: "POST", body: { known_attributes: c.conhecidos ?? [] } });
        const lista = ((r.dados ?? []) as any[]).map((v) => ({ id: v.id, nome: v.name }));
        lista.sort((a, b) => c.atributo === "VEHICLE_YEAR" ? b.nome.localeCompare(a.nome) : a.nome.localeCompare(b.nome));
        return json({ valores: lista });
      }

      case "compat_buscar": {
        const achados: any[] = [];
        // Paginação vai na URL (no corpo é ignorada) e o ML entrega no máximo 50 por vez.
        for (let pagina = 0; pagina < 20; pagina++) {
          const r = await chamar(`/catalog_compatibilities/products_search/chunks?offset=${pagina * 50}&limit=50`, t.auth, { method: "POST",
            body: { domain_id: DOMINIO_CARROS, site_id: "MLB", known_attributes: c.conhecidos ?? [] } });
          const res = (r.dados?.results ?? []) as any[];
          achados.push(...res);
          if (res.length < 50 || achados.length >= (r.dados?.total ?? 0)) break;
        }
        const nome = (p: any, k: string) => (p.attributes ?? []).find((a: any) => a.id === k)?.value_name ?? "";
        return json({ veiculos: achados.map((p) => ({ id: p.id,
          nome: [nome(p, "BRAND"), nome(p, "MODEL"), nome(p, "VEHICLE_YEAR"), nome(p, "TRIM")].filter(Boolean).join(" ") })) });
      }

      case "compat_adicionar":
      case "compat_copiar": {
        let ids = (c.ids ?? []) as string[];
        if (c.acao === "compat_copiar") {
          const { data: dono } = await sb.from("ml_anuncios").select("conta").eq("item_id", c.de_item).maybeSingle();
          const td = dono ? await token(dono.conta) : t;
          const origem = await chamar(`/items/${c.de_item}/compatibilities`, td.auth);
          if (!origem.ok) return json({ ok: false, motivo: "não consegui ler a compatibilidade de " + c.de_item });
          ids = ((origem.dados?.products ?? []) as any[]).map((p) => p.catalog_product_id);
        }
        const antes = await chamar(`/items/${id}/compatibilities`, t.auth);
        const jaTem = new Set(((antes.dados?.products ?? []) as any[]).map((p) => p.catalog_product_id));
        const novos = [...new Set(ids)].filter((x) => !jaTem.has(x));
        if (!novos.length) return json({ ok: true, adicionados: 0, motivo: "todos esses veículos já estavam no anúncio" });
        let adicionados = 0;
        const erros: string[] = [];
        for (let i = 0; i < novos.length; i += 200) {
          const r = await chamar(`/items/${id}/compatibilities`, t.auth, { method: "POST",
            body: { products: novos.slice(i, i + 200).map((x) => ({ id: x })) } });
          if (r.ok) adicionados += novos.slice(i, i + 200).length; else erros.push(motivo(r));
        }
        const depois = await chamar(`/items/${id}/compatibilities`, t.auth);
        const total = (depois.dados?.products ?? []).length;
        await registrar(conta, id, erros.length ? "falhou" : "compatibilidade",
          `compatibilidade: +${adicionados} veículo(s)${c.de_item ? " copiados de " + c.de_item : ""}${erros.length ? " · " + erros[0] : ""}`);
        return json({ ok: !erros.length && total >= jaTem.size + adicionados, adicionados, total, motivo: erros[0] });
      }

      case "compat_remover": {
        const ids = (c.ids ?? []) as string[];
        const erros: string[] = [];
        for (const x of ids) {
          const r = await chamar(`/items/${id}/compatibilities/${x}`, t.auth, { method: "DELETE" });
          if (!r.ok && r.status !== 404) erros.push(motivo(r));
        }
        const depois = await chamar(`/items/${id}/compatibilities`, t.auth);
        const restantes = new Set(((depois.dados?.products ?? []) as any[]).map((p) => String(p.id)));
        const ficaram = ids.filter((x) => restantes.has(String(x)));
        await registrar(conta, id, ficaram.length ? "falhou" : "compatibilidade",
          `compatibilidade: -${ids.length - ficaram.length} veículo(s)${ficaram.length ? " · " + (erros[0] ?? "o ML não removeu " + ficaram.length) : ""}`);
        return json({ ok: !ficaram.length, removidos: ids.length - ficaram.length, motivo: ficaram.length ? (erros[0] ?? "o ML não removeu") : undefined });
      }
    }
    return json({ erro: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
