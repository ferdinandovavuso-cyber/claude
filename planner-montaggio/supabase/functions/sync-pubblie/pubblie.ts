// Client MCP minimale per Pubblie e raccolta dei post.
// Nessuna dipendenza da Supabase, così si può testare da solo contro un server finto.
// deno-lint-ignore-file no-explicit-any

export interface PubblieConfig {
  url: string;
  token: string;
}

export interface PublicationRow {
  pubblie_id: string;
  client_id: string | null;
  channel: string;
  date: string;
  status: string;
  has_video: boolean;
  excerpt: string | null;
  synced_at: string;
}

// ---------- Client MCP (Streamable HTTP, JSON-RPC) ----------
export function mcpClient({ url, token }: PubblieConfig) {
  let sessionId: string | null = null;
  let rpcId = 0;

  async function rpc(method: string, params: unknown = {}, notification = false): Promise<any> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const id = notification ? undefined : ++rpcId;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(`${method}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    if (notification) {
      await res.body?.cancel();
      return null;
    }

    const text = await res.text();
    const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).map((d) => JSON.parse(d))
      : [JSON.parse(text)];
    const msg = messages.find((m) => m.id === id);
    if (!msg) throw new Error(`${method}: nessuna risposta`);
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result;
  }

  return {
    async connect() {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fvl-montaggio-sync", version: "1.0" },
      });
      await rpc("notifications/initialized", {}, true);
    },
    async tool(name: string, args: Record<string, unknown>): Promise<any> {
      const result = await rpc("tools/call", { name, arguments: args });
      const text = result?.content?.find((c: any) => c.type === "text")?.text;
      if (result?.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text ?? "null");
    },
  };
}

// ---------- Traduzione dei post ----------
export function statusOf(p: any): string | null {
  const accounts = p.accounts ?? [];
  const published = accounts.filter((a: any) => a.status === "PUBLISHED").length;
  const gone = accounts.filter((a: any) => a.status === "NOT_FOUND").length;
  switch (p.status) {
    case "SCHEDULED":
    case "PUBLISHING":
      return "scheduled";
    case "PUBLISHED":
      return accounts.length && gone === accounts.length ? "removed" : "published";
    case "ERROR":
      return published ? "partial" : "error";
    default:
      return null; // bozze e stati sconosciuti non contano
  }
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

// Legge tutti i progetti Pubblie tra from e to, a finestre di windowDays giorni
// (list_posts restituisce al massimo 50 post per chiamata).
export async function collectPosts(
  cfg: PubblieConfig,
  byAccount: Map<string, string>,
  from: Date,
  to: Date,
  windowDays = 7,
) {
  const mcp = mcpClient(cfg);
  await mcp.connect();

  const teams = await mcp.tool("list_projects", {});
  const projects = (teams ?? []).flatMap((t: any) => t.projects ?? []);
  const rows = new Map<string, PublicationRow>();
  const unmapped = new Set<string>();
  const truncated: string[] = [];
  const syncedAt = new Date().toISOString();

  for (const project of projects) {
    for (let start = from; start <= to; start = addDays(start, windowDays)) {
      const end = addDays(start, windowDays - 1);
      const res = await mcp.tool("list_posts", { projectId: project.id, dateFrom: isoDay(start), dateTo: isoDay(end) });
      const posts = res?.posts ?? [];
      if (posts.length >= 50) truncated.push(`${project.name} dal ${isoDay(start)}`);
      for (const p of posts) {
        const status = statusOf(p);
        if (!status) continue;
        const names: string[] = (p.accounts ?? []).map((a: any) => a.accountName);
        const clientId = names.map((n) => byAccount.get(n)).find(Boolean) ?? null;
        if (!clientId && names[0]) unmapped.add(names[0]);
        const firstLine = String(p.body ?? "").split("\n")[0].replace(/\.{3}$/, "").trim();
        rows.set(p.id, {
          pubblie_id: p.id,
          client_id: clientId,
          channel: names[0] ?? project.name,
          date: String(p.scheduleDate).slice(0, 10),
          status,
          has_video: !!p.hasVideo,
          excerpt: firstLine.slice(0, 90) || null,
          synced_at: syncedAt,
        });
      }
    }
  }
  return { rows: [...rows.values()], unmapped: [...unmapped], truncated, projects: projects.length };
}
