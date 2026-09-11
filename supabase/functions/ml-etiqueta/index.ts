import { createClient } from "jsr:@supabase/supabase-js@2";
import JSZip from "npm:jszip@3.10.1";

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

function erroJson(mensagem: string, status: number, detalhe?: unknown) {
  return new Response(JSON.stringify({ erro: mensagem, detalhe: detalhe ?? null }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(req.url);
  const orderId = url.searchParams.get("pedido");

  if (!orderId) return erroJson("Falta o parâmetro 'pedido' (ml_order_id)", 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: pedido, error: errPedido } = await supabase
    .from("ml_pedidos")
    .select("conta, shipping_id")
    .eq("ml_order_id", orderId)
    .maybeSingle();

  if (errPedido || !pedido) return erroJson("Pedido não encontrado no sistema.", 404);
  if (!pedido.shipping_id) {
    return erroJson("Este pedido ainda não tem código de envio salvo. Sincronize novamente (botão ‘Sincronizar agora’) e tente de novo em alguns minutos.", 400);
  }

  const { data: conta, error: errConta } = await supabase
    .from("ml_tokens")
    .select("*")
    .eq("conta", pedido.conta)
    .maybeSingle();

  if (errConta || !conta) return erroJson("Conta ML não encontrada.", 404);

  let accessToken = conta.access_token;
  const expiraEm = new Date(conta.expires_at).getTime() - Date.now();
  if (expiraEm < 10 * 60 * 1000) {
    const novo = await renovarToken(supabase, conta);
    if (novo) accessToken = novo;
  }

  // Checa o status do envio ANTES de tentar a etiqueta, pra dar uma mensagem certeira
  let substatus: string | null = null;
  try {
    const shipResp = await fetch(`https://api.mercadolibre.com/shipments/${pedido.shipping_id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (shipResp.ok) {
      const shipData = await shipResp.json();
      substatus = shipData.substatus ?? null;
    }
  } catch (_e) {
    // se essa checagem falhar, segue tentando a etiqueta normalmente
  }

  if (substatus === "invoice_pending" || substatus === "invoice_missing") {
    return erroJson("📄 Emita a Nota Fiscal (NF-e) desse pedido no Mercado Livre antes de imprimir a etiqueta. O Mercado Livre só libera a etiqueta de envio depois que a NF-e é validada.", 409);
  }
  if (substatus === "buffered") {
    return erroJson("⏳ Este envio ainda está em espera de liberação pelo Mercado Livre (comum em Cross Docking/Turbo, pra não sobrecarregar a transportadora). Não tem nada a ver com nota fiscal — tente novamente mais tarde, o ML libera automaticamente numa data próxima.", 409);
  }

  // response_type=zpl2: formato térmico pra Zebra. O ML já empacota a etiqueta de envio
  // JUNTO com a DANFE simplificada (quando a NF-e foi emitida via integração do Mercado Envios),
  // tudo num só arquivo de texto ZPL pronto pra mandar direto à impressora.
  const labelResp = await fetch(
    `https://api.mercadolibre.com/shipment_labels?shipment_ids=${pedido.shipping_id}&response_type=zpl2`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!labelResp.ok) {
    const texto = await labelResp.text();
    var mensagemAmigavel = "Falha ao buscar etiqueta no Mercado Livre.";
    if (/invoice|fiscal|nota/i.test(texto)) {
      mensagemAmigavel = "📄 Emita a Nota Fiscal (NF-e) desse pedido no Mercado Livre antes de imprimir a etiqueta.";
    } else if (/FF_PUBLIC|is FF/i.test(texto)) {
      mensagemAmigavel = "Pedido Full não precisa de etiqueta — o próprio Mercado Livre despacha.";
    } else if (/NOT_PRINTABLE_STATUS/i.test(texto)) {
      mensagemAmigavel = "Este pedido não está mais no status de gerar etiqueta (já avançou ou ainda não chegou a hora, ou já foi impressa/despachada). Confira o status direto no Mercado Livre.";
    }
    return erroJson(mensagemAmigavel, labelResp.status, texto);
  }

  const zipBytes = await labelResp.arrayBuffer();
  let zplTexto = "";
  try {
    const zip = await JSZip.loadAsync(zipBytes);
    const arquivoTxt = Object.values(zip.files).find((f: any) => !f.dir && /\.txt$/i.test(f.name));
    if (!arquivoTxt) return erroJson("O Mercado Livre não devolveu o arquivo de etiqueta térmica esperado.", 500);
    zplTexto = await (arquivoTxt as any).async("text");
  } catch (e) {
    return erroJson("Falha ao processar o arquivo da etiqueta.", 500, String(e));
  }

  return new Response(JSON.stringify({ zpl: zplTexto }), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
