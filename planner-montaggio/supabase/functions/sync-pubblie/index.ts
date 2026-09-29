// Sincronizza i post di Pubblie nella tabella publications, chiamando direttamente il server MCP di Pubblie.
// Nessun modello AI coinvolto: solo richieste HTTP, quindi zero token.
//
// GET  ?action=connect&k=<chiave>&return=<url app>  → avvia il login OAuth su Pubblie
// GET  ?code=...&state=...                           → ritorno da Pubblie, salva i token
// POST (header x-planner-key)                        → sincronizza (lo chiamano il cron e il pulsante nell'app)
//
// I token OAuth stanno nella tabella pubblie_oauth, leggibile solo con la service role.
// Il secret opzionale PUBBLIE_MCP_TOKEN, se presente, scavalca OAuth.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { addDays, collectPosts, isoDay } from "./pubblie.ts";
import { authorizeUrl, exchangeCode, PUBBLIE, randomToken, registerClient, validAccessToken } from "./oauth.ts";

const PAST_DAYS = 7; // riguarda l'ultima settimana per aggiornare gli stati (pubblicato, errore, rimosso)
const FUTURE_DAYS = 60; // e i prossimi due mesi di programmati
const APP_ORIGINS = ["https://fvl-montaggio.vercel.app", "https://montaggio.fvlmedia.it", "http://localhost:8765"];

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-planner-key, apikey, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

const validKey = async (sb: SupabaseClient, key: string) =>
  !!key && !!(await sb.from("planner_access").select("key").eq("key", key).maybeSingle()).data;

const withParam = (base: string, name: string, value: string) => {
  const url = new URL(base);
  url.searchParams.set(name, value);
  return url.toString();
};

async function loadOAuth(sb: SupabaseClient) {
  const { data, error } = await sb.from("pubblie_oauth").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
}
const saveOAuth = (sb: SupabaseClient, fields: Record<string, unknown>) =>
  sb.from("pubblie_oauth").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", 1);

// ---------- Collegamento OAuth ----------
async function startConnect(sb: SupabaseClient, url: URL, selfUrl: string) {
  if (!(await validKey(sb, url.searchParams.get("k") ?? ""))) return json({ error: "chiave non valida" }, 403);
  const returnTo = url.searchParams.get("return") ?? APP_ORIGINS[0];
  if (!APP_ORIGINS.some((o) => returnTo.startsWith(o))) return json({ error: "indirizzo di ritorno non ammesso" }, 400);

  let s = await loadOAuth(sb);
  if (!s.client_id || s.redirect_uri !== selfUrl) {
    const client = await registerClient(selfUrl);
    await saveOAuth(sb, { ...client, redirect_uri: selfUrl });
    s = { ...s, ...client, redirect_uri: selfUrl };
  }
  const verifier = randomToken(48);
  const state = randomToken(24);
  await saveOAuth(sb, { pkce_verifier: verifier, oauth_state: state, return_to: returnTo });
  return redirect(await authorizeUrl(s.client_id, selfUrl, verifier, state));
}

async function finishConnect(sb: SupabaseClient, url: URL) {
  const s = await loadOAuth(sb);
  const back = s.return_to ?? APP_ORIGINS[0];
  const error = url.searchParams.get("error");
  if (error) return redirect(withParam(back, "pubblie", `errore: ${url.searchParams.get("error_description") ?? error}`));
  if (!s.oauth_state || url.searchParams.get("state") !== s.oauth_state) {
    return redirect(withParam(back, "pubblie", "errore: sessione di collegamento scaduta, riprova"));
  }
  try {
    const tokens = await exchangeCode(s, url.searchParams.get("code") ?? "", s.pkce_verifier);
    await saveOAuth(sb, { ...tokens, pkce_verifier: null, oauth_state: null, connected_at: new Date().toISOString() });
    return redirect(withParam(back, "pubblie", "collegato"));
  } catch (e) {
    return redirect(withParam(back, "pubblie", `errore: ${e instanceof Error ? e.message : String(e)}`));
  }
}

// ---------- Sincronizzazione ----------
async function accessToken(sb: SupabaseClient) {
  const override = Deno.env.get("PUBBLIE_MCP_TOKEN");
  if (override) return override;
  const s = await loadOAuth(sb);
  const { token, changed } = await validAccessToken(s);
  if (changed) await saveOAuth(sb, changed);
  return token;
}

async function sync(sb: SupabaseClient) {
  const { data: run } = await sb.from("sync_runs").insert({}).select("id").single();
  const finish = (fields: Record<string, unknown>) =>
    sb.from("sync_runs").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", run!.id);

  try {
    const token = await accessToken(sb);
    const url = Deno.env.get("PUBBLIE_MCP_URL") ?? PUBBLIE.mcp;

    const { data: clients, error: clientsError } = await sb.from("clients").select("id, pubblie_accounts");
    if (clientsError) throw clientsError;
    const byAccount = new Map<string, string>();
    for (const c of clients ?? []) for (const a of c.pubblie_accounts ?? []) byAccount.set(a, c.id);

    const now = new Date();
    const from = addDays(now, -PAST_DAYS);
    const to = addDays(now, FUTURE_DAYS);
    const { rows, unmapped, truncated } = await collectPosts({ url, token }, byAccount, from, to);

    if (rows.length) {
      const { error } = await sb.from("publications").upsert(rows, { onConflict: "pubblie_id" });
      if (error) throw error;
    }

    // Programmati cancellati o spostati su Pubblie: vanno tolti anche qui.
    let stale = sb.from("publications").delete().eq("status", "scheduled").gte("date", isoDay(from)).lte("date", isoDay(to));
    if (rows.length) stale = stale.not("pubblie_id", "in", `(${rows.map((r) => `"${r.pubblie_id}"`).join(",")})`);
    const { error: staleError } = await stale;
    if (staleError) throw staleError;

    const warning = truncated.length ? `Finestre con 50 post, potrebbero mancarne: ${truncated.join(", ")}` : null;
    await finish({ ok: true, posts: rows.length, unmapped, error: warning });
    return json({ ok: true, posts: rows.length, unmapped, warning });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finish({ ok: false, error: message });
    return json({ ok: false, error: message }, 502);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  const selfUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-pubblie`;

  try {
    if (req.method === "GET" && url.searchParams.get("action") === "connect") return await startConnect(sb, url, selfUrl);
    if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) return await finishConnect(sb, url);
    if (req.method !== "POST") return json({ error: "metodo non ammesso" }, 405);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }

  if (!(await validKey(sb, req.headers.get("x-planner-key") ?? ""))) return json({ error: "chiave non valida" }, 403);
  return await sync(sb);
});
