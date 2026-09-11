import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REDIRECT_URI = "https://pylkufhziohxvwbbaued.supabase.co/functions/v1/ml-oauth";

function base64url(bytes: Uint8Array): string {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function gerarVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function gerarChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(digest));
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const conta = url.searchParams.get("conta");

  if (!conta) {
    return new Response(JSON.stringify({ erro: "Falta o parâmetro 'conta' (KMP, ERP ou LTS)" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const verifier = gerarVerifier();
  const challenge = await gerarChallenge(verifier);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase.from("ml_pkce").upsert(
    { conta, code_verifier: verifier, criado_em: new Date().toISOString() },
    { onConflict: "conta" }
  );
  if (error) {
    return new Response(JSON.stringify({ erro: "Falha ao guardar PKCE", detalhe: error }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authUrl = new URL("https://auth.mercadolivre.com.br/authorization");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", ML_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("state", conta);
  authUrl.searchParams.set("scope", "offline_access read write");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl.toString() },
  });
});
