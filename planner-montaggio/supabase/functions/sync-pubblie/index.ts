// Sincronizza i post di Pubblie nella tabella publications, chiamando direttamente il server MCP di Pubblie.
// Nessun modello AI coinvolto: solo richieste HTTP, quindi zero token.
//
// Secret richiesti (Supabase → Edge Functions → Secrets):
//   PUBBLIE_MCP_URL    indirizzo del server MCP di Pubblie
//   PUBBLIE_MCP_TOKEN  token/chiave API di Pubblie (inviato come "Authorization: Bearer ...")
// Accesso: la richiesta deve portare una chiave valida del planner nell'header x-planner-key
// (la stessa del link segreto), così la possono lanciare sia il cron sia il pulsante nell'app.
import { createClient } from "npm:@supabase/supabase-js@2";
import { addDays, collectPosts, isoDay } from "./pubblie.ts";

const PAST_DAYS = 7; // riguarda l'ultima settimana per aggiornare gli stati (pubblicato, errore, rimosso)
const FUTURE_DAYS = 60; // e i prossimi due mesi di programmati

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-planner-key, apikey, authorization",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const key = req.headers.get("x-planner-key") ?? "";
  const { data: access } = await sb.from("planner_access").select("key").eq("key", key).maybeSingle();
  if (!key || !access) return json({ error: "chiave non valida" }, 403);

  const url = Deno.env.get("PUBBLIE_MCP_URL");
  const token = Deno.env.get("PUBBLIE_MCP_TOKEN");
  if (!url || !token) return json({ error: "Mancano i secret PUBBLIE_MCP_URL e PUBBLIE_MCP_TOKEN" }, 500);

  const { data: run } = await sb.from("sync_runs").insert({}).select("id").single();
  const finish = (fields: Record<string, unknown>) =>
    sb.from("sync_runs").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", run!.id);

  try {
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
});
