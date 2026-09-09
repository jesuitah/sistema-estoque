import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function renovarToken(supabase: any, conta: any): Promise<string | null> {
  if (!conta.refresh_token) return null;
  const resp = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conta.refresh_token,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) return null;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await supabase.from("ml_tokens").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? conta.refresh_token,
    expires_at: expiresAt,
    atualizado_em: new Date().toISOString(),
  }).eq("conta", conta.conta);
  return data.access_token;
}

async function buscarInfoEnvio(accessToken: string, shippingId: any): Promise<{ logisticType: string | null; substatus: string | null }> {
  if (!shippingId) return { logisticType: null, substatus: null };
  try {
    const resp = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return { logisticType: null, substatus: null };
    const data = await resp.json();
    return { logisticType: data.logistic_type ?? null, substatus: data.substatus ?? null };
  } catch (_e) {
    return { logisticType: null, substatus: null };
  }
}

async function processarConta(supabase: any, conta: any) {
  let accessToken = conta.access_token;

  const expiraEm = new Date(conta.expires_at).getTime() - Date.now();
  if (expiraEm < 10 * 60 * 1000) {
    const novo = await renovarToken(supabase, conta);
    if (novo) {
      accessToken = novo;
    } else if (expiraEm < 0) {
      return { erro: "token expirado e sem refresh_token válido — precisa reautorizar" };
    }
  }

  const resp = await fetch(
    `https://api.mercadolibre.com/orders/search?seller=${conta.user_id}&sort=date_desc&limit=40`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await resp.json();
  if (!resp.ok) return { erro: "falha ao buscar pedidos", detalhe: data };

  const resultados = data.results ?? [];
  const idsRecebidos = resultados.map((p: any) => p.id);

  // SE ESTA CONSULTA FALHAR, NÃO DÁ PRA CONTINUAR.
  //
  // Ela é quem diz quais pedidos já existem. Antes o erro era ignorado: `existentes`
  // vinha vazio, TODO pedido era tratado como novo, e o passo de inserção sobrescrevia
  // os que já estavam lá — devolvendo pedidos já despachados para a fila da expedição.
  // Vazio por falha e vazio por não haver nada são coisas diferentes.
  const { data: existentes, error: erroExistentes } = await supabase
    .from("ml_pedidos")
    .select("ml_order_id, processado, status, logistic_type, shipping_id, envio_substatus")
    .in("ml_order_id", idsRecebidos.length ? idsRecebidos : [0]);
  if (erroExistentes) {
    return { erro: "falha ao ler os pedidos já salvos — nada foi alterado", detalhe: erroExistentes };
  }
  const mapaExistentes = new Map((existentes ?? []).map((r: any) => [r.ml_order_id, r]));

  let novos = 0, atualizados = 0;

  for (const p of resultados) {
    const existente = mapaExistentes.get(p.id);

    if (!existente) {
      const info = await buscarInfoEnvio(accessToken, p.shipping?.id);
      const cancelado = p.status === "cancelled";

      // INSERE, NUNCA SOBRESCREVE.
      //
      // `ignoreDuplicates` transforma isto em "insere se não existir, senão não faz
      // nada". É a trava de segurança: mesmo que a leitura acima erre de alguma forma
      // que não conhecemos, um pedido já registrado JAMAIS volta para `processado =
      // false` por causa deste passo. O que precisar ser atualizado num pedido
      // existente é feito no bloco de baixo, que nunca toca em `processado`.
      //
      // Em 09/09/2026 três pedidos da LTS que já tinham sido baixados reapareceram na
      // fila. Não consegui reproduzir o caminho exato, mas este é o único ponto do
      // sistema que escreve `false` — então ele deixou de poder fazê-lo.
      const { error } = await supabase.from("ml_pedidos").upsert({
        ml_order_id: p.id,
        conta: conta.conta,
        status: p.status,
        comprador: p.buyer?.nickname ?? null,
        valor_total: p.total_amount,
        itens: p.order_items,
        data_criacao_ml: p.date_created,
        logistic_type: info.logisticType,
        shipping_id: p.shipping?.id ?? null,
        envio_substatus: info.substatus,
        is_full: info.logisticType === null ? null : info.logisticType === "fulfillment",
        processado: cancelado,
      }, { onConflict: "ml_order_id", ignoreDuplicates: true });
      if (error) return { erro: "falha ao salvar pedido", detalhe: error };
      novos++;
      continue;
    }

    if (existente.processado) continue;

    const patch: any = {};
    if (existente.status !== p.status) patch.status = p.status;
    if (p.status === "cancelled") patch.processado = true;

    const info = await buscarInfoEnvio(accessToken, p.shipping?.id);
    if (info.substatus !== existente.envio_substatus) patch.envio_substatus = info.substatus;
    if (existente.logistic_type === null && info.logisticType !== null) {
      patch.logistic_type = info.logisticType;
      patch.is_full = info.logisticType === "fulfillment";
    }
    if (!existente.shipping_id && p.shipping?.id) patch.shipping_id = p.shipping.id;

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("ml_pedidos").update(patch).eq("ml_order_id", p.id);
      if (error) return { erro: "falha ao atualizar pedido", detalhe: error };
      atualizados++;
    }
  }

  return { novos, pendentes_atualizados: atualizados, total_recebidos: idsRecebidos.length };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: contas, error: errContas } = await supabase
    .from("ml_tokens")
    .select("conta, user_id, access_token, refresh_token, expires_at");

  if (errContas || !contas) {
    return new Response(JSON.stringify({ erro: "Falha ao buscar contas", detalhe: errContas }), {
      status: 500, headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const entradas = await Promise.all(
    contas.map(async (c: any) => [c.conta, await processarConta(supabase, c)])
  );
  const resultado = Object.fromEntries(entradas);

  return new Response(JSON.stringify(resultado, null, 2), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
