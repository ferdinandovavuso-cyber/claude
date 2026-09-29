// OAuth 2 verso Pubblie (authorization code + PKCE, registrazione dinamica del client, refresh token).
// Endpoint presi da https://pubblie.io/.well-known/oauth-authorization-server.
// Nessuna dipendenza da Supabase: lo stato si passa dentro e fuori, così si può testare da solo.
// deno-lint-ignore-file no-explicit-any

export const PUBBLIE = {
  mcp: "https://pubblie.io/mcp",
  authorize: "https://pubblie.io/connect/authorize",
  token: "https://pubblie.io/connect/token",
  register: "https://pubblie.io/connect/register",
  scope: "api offline_access",
};

export interface OAuthState {
  client_id: string | null;
  client_secret: string | null;
  redirect_uri: string | null;
  access_token: string | null;
  access_expires_at: string | null;
  refresh_token: string | null;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

async function postForm(url: string, form: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* risposta non JSON */ }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${data?.error_description ?? data?.error ?? text.slice(0, 200)}`);
  return data;
}

// Registra il planner come app presso Pubblie (una volta sola, o se cambia l'indirizzo di ritorno).
export async function registerClient(redirectUri: string, endpoints = PUBBLIE) {
  const res = await fetch(endpoints.register, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "FVL Media · Planner Montaggio",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: endpoints.scope,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.client_id) throw new Error(`Registrazione su Pubblie fallita: HTTP ${res.status} ${JSON.stringify(data)?.slice(0, 200)}`);
  return { client_id: String(data.client_id), client_secret: data.client_secret ? String(data.client_secret) : null };
}

export async function authorizeUrl(clientId: string, redirectUri: string, verifier: string, state: string, endpoints = PUBBLIE) {
  const url = new URL(endpoints.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: endpoints.scope,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function tokensFrom(data: any, previousRefresh: string | null) {
  if (!data?.access_token) throw new Error("Pubblie non ha restituito un access token");
  const seconds = Number(data.expires_in) || 3600;
  return {
    access_token: String(data.access_token),
    access_expires_at: new Date(Date.now() + seconds * 1000).toISOString(),
    // Alcuni server ruotano il refresh token, altri no: se non ne arriva uno nuovo si tiene il vecchio.
    refresh_token: data.refresh_token ? String(data.refresh_token) : previousRefresh,
  };
}

const clientAuth = (s: Pick<OAuthState, "client_id" | "client_secret">): Record<string, string> =>
  s.client_secret ? { client_id: s.client_id!, client_secret: s.client_secret } : { client_id: s.client_id! };

export async function exchangeCode(s: OAuthState, code: string, verifier: string, endpoints = PUBBLIE) {
  const data = await postForm(endpoints.token, {
    grant_type: "authorization_code",
    code,
    redirect_uri: s.redirect_uri!,
    code_verifier: verifier,
    ...clientAuth(s),
  });
  return tokensFrom(data, null);
}

// Restituisce un access token valido, rinnovandolo se scade entro un minuto.
// `changed` è valorizzato quando i token sono cambiati e vanno salvati.
export async function validAccessToken(s: OAuthState, endpoints = PUBBLIE) {
  const stillValid = s.access_token && s.access_expires_at && new Date(s.access_expires_at).getTime() > Date.now() + 60_000;
  if (stillValid) return { token: s.access_token!, changed: null };
  if (!s.refresh_token || !s.client_id) throw new Error("Pubblie non collegato: premi «Collega Pubblie» nel planner");
  const data = await postForm(endpoints.token, {
    grant_type: "refresh_token",
    refresh_token: s.refresh_token,
    ...clientAuth(s),
  });
  const changed = tokensFrom(data, s.refresh_token);
  return { token: changed.access_token, changed };
}
