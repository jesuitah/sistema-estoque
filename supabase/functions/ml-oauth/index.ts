import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REDIRECT_URI = "https://pylkufhziohxvwbbaued.supabase.co/functions/v1/ml-oauth";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const conta = url.searchParams.get("state");

  if (!code || !conta) {
    return new Response(
      JSON.stringify({ erro: "Faltou 'code' ou 'state' (nome da conta) na URL" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: pkce } = await supabase
    .from("ml_pkce")
    .select("code_verifier")
    .eq("conta", conta)
    .maybeSingle();

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
  };
  if (pkce?.code_verifier) {
    body.code_verifier = pkce.code_verifier;
  }

  const tokenResp = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

  const tokenData = await tokenResp.json();

  if (!tokenResp.ok) {
    return new Response(JSON.stringify({ erro: "Falha ao trocar code por token", detalhe: tokenData }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

  const { error } = await supabase.from("ml_tokens").upsert(
    {
      conta,
      user_id: tokenData.user_id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? null,
      expires_at: expiresAt,
      scope_concedido: tokenData.scope ?? null,
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: "conta" }
  );

  if (error) {
    return new Response(JSON.stringify({ erro: "Falha ao salvar token", detalhe: error }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  await supabase.from("ml_pkce").delete().eq("conta", conta);

  const temRefresh = tokenData.refresh_token ? "SIM ✅" : "NÃO ❌";
  const temOffline = (tokenData.scope || "").includes("offline_access") ? "SIM" : "NÃO";
  return new Response(
    `<html><body style="font-family:sans-serif;text-align:center;margin-top:80px;"><h2>Conta ${conta} conectada!</h2><p>refresh_token: ${temRefresh}</p><p>offline_access concedido: ${temOffline}</p><p>Pode fechar esta aba.</p></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
});
