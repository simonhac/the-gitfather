// ─────────────────────────────────────────────────────────────────────────────
// gitfather-scheduler — a single Cloudflare Worker that replaces GitHub Actions cron.
//
// One Cron Trigger (*/10 * * * *) wakes the Worker every 10 minutes. It decides which cadences are
// due from event.scheduledTime (the *intended* tick instant — not Date.now(), so a late delivery still
// maps to the slot it was meant for) and fires each client's caller workflow via GitHub's REST
// `workflow_dispatch` API. Nothing about the backup/verify/self-heal logic moves — only the trigger.
//
// The reliability guarantee is unchanged: the staleness watchdog still runs INSIDE GitHub Actions
// (the-gitfather scripts/check-staleness.ts) and self-heals a missed backup; this Worker just dispatches
// it on a cadence. If the Worker itself dies, the external HEARTBEAT_URL dead-man's-switch pages.
//
// Client identifiers (owner/repo) are NEVER in source — they live in the CLIENTS secret. Logs written
// to the shared (public) dashboard bucket carry only opaque ids, never owner/repo. See README.md.
// ─────────────────────────────────────────────────────────────────────────────

export interface Env {
  GH_TOKEN: string; // secret: fine-grained PAT (Actions: Read and write) scoped to the client repos
  CLIENTS: string; // secret: JSON roster (see Client[] below) — keeps repo names out of source
  TRIGGER_SECRET: string; // secret: shared secret gating the manual /trigger and /state endpoints
  STATE: R2Bucket; // binding: shared dashboard bucket (free, in-network) — scheduler state + logs
}

type Cadence = "backup" | "staleness" | "durableVerify" | "restoreDrill";

interface Client {
  id: string; // opaque label — the ONLY client identifier that may appear in logs
  owner: string;
  repo: string;
  cadences?: Cadence[]; // optional allowlist of cadences this client runs (default: all)
  workflows?: Partial<Record<Cadence, string>>; // optional per-client filename overrides (default: DEFAULT_WORKFLOWS)
}

interface DispatchResult {
  id: string;
  cadence: Cadence;
  status: number; // HTTP status from GitHub; 204 = success, 0 = client not subscribed, -1 = network error
  error?: string;
}

const REF = "main"; // branch in the client repo whose caller workflow we dispatch
const ALL_CADENCES: readonly Cadence[] = ["backup", "staleness", "durableVerify", "restoreDrill"];

// the-gitfather's conventional caller-workflow filenames. They're identical across consuming repos by
// convention, so they live here as defaults rather than being repeated for every client in the roster.
// A client overrides one only if it named its caller file differently.
const DEFAULT_WORKFLOWS: Record<Cadence, string> = {
  backup: "pg-backup.yml",
  staleness: "pg-staleness-check.yml",
  durableVerify: "pg-durable-verify.yml",
  restoreDrill: "pg-restore-drill.yml",
};

const workflowFor = (c: Client, cadence: Cadence): string => c.workflows?.[cadence] ?? DEFAULT_WORKFLOWS[cadence];
const subscribes = (c: Client, cadence: Cadence): boolean => (c.cadences ? c.cadences.includes(cadence) : true);

// Which cadences are due on THIS 10-min tick? All cadences are sub-harmonics of 10 minutes, so a single
// */10 trigger covers everything (1 of the free plan's 5 cron-trigger slots). All math is UTC.
function dueCadences(t: Date): Cadence[] {
  const due: Cadence[] = ["staleness"]; // every tick (the 10-min watchdog)
  const m = t.getUTCMinutes();
  const h = t.getUTCHours();
  if (m === 0 && h % 2 === 0) due.push("backup"); // every 2h (== the old "0 */2 * * *")
  if (h === 18 && m === 30) due.push("durableVerify"); // daily ~18:30 UTC — must be after the latest anchor hour
  // restoreDrill is superseded by durableVerify; dispatch it only via the manual /trigger endpoint if needed.
  return due;
}

// Only the backup caller declares a workflow_dispatch input. reason="schedule" makes runOrigin() render it
// as a clean scheduled run (no 🖐️ marker). The other callers take no inputs — extra keys → HTTP 422.
function inputsFor(cadence: Cadence): Record<string, string> {
  return cadence === "backup" ? { reason: "schedule" } : {};
}

function parseClients(env: Env): Client[] {
  const raw: unknown = JSON.parse(env.CLIENTS);
  if (!Array.isArray(raw)) throw new Error("CLIENTS secret must be a JSON array");
  return raw as Client[];
}

function safeParseClients(env: Env): Client[] | null {
  try {
    return parseClients(env);
  } catch (e) {
    console.error(`CLIENTS parse failed: ${String(e)}`);
    return null;
  }
}

function isCadence(s: string | null): s is Cadence {
  return s !== null && (ALL_CADENCES as readonly string[]).includes(s);
}

// Fire one client's caller workflow. Never throws — failures are captured so one broken client can't
// suppress the others. A 204 is success; anything else is logged with the response body.
async function dispatch(env: Env, c: Client, cadence: Cadence): Promise<DispatchResult> {
  if (!subscribes(c, cadence)) return { id: c.id, cadence, status: 0 };
  const file = workflowFor(c, cadence);
  const url = `https://api.github.com/repos/${c.owner}/${c.repo}/actions/workflows/${file}/dispatches`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gitfather-scheduler", // GitHub rejects requests with no User-Agent
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF, inputs: inputsFor(cadence) }),
    });
    if (res.status === 204) {
      console.log(`dispatch ok: ${c.id}/${cadence} -> ${file}`);
      return { id: c.id, cadence, status: 204 };
    }
    // 401 bad/expired token · 403 token lacks Actions:write (or rate-limited) · 404 wrong repo/file or the
    // caller lacks a workflow_dispatch trigger · 422 unknown input.
    const body = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`dispatch FAIL ${res.status}: ${c.id}/${cadence} ${file} :: ${body}`);
    return { id: c.id, cadence, status: res.status, error: body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dispatch ERROR: ${c.id}/${cadence} ${file} :: ${msg}`);
    return { id: c.id, cadence, status: -1, error: msg };
  }
}

async function fanOut(env: Env, cadences: Cadence[], clients: Client[]): Promise<DispatchResult[]> {
  // dispatch() catches internally, so Promise.all never rejects.
  return Promise.all(cadences.flatMap((cad) => clients.map((c) => dispatch(env, c, cad))));
}

interface TickRecord {
  tick: string;
  cadences: Cadence[];
  dispatches: { id: string; cadence: Cadence; status: number; error?: string }[];
}

function toTickRecord(t: Date, cadences: Cadence[], results: DispatchResult[]): TickRecord {
  return {
    tick: t.toISOString(),
    cadences,
    dispatches: results
      .filter((r) => r.status !== 0) // drop "not subscribed" no-ops
      .map((r) => ({ id: r.id, cadence: r.cadence, status: r.status, ...(r.error ? { error: r.error } : {}) })),
  };
}

// Persist scheduler state/logs to the SHARED dashboard bucket. It is public, so we record opaque ids +
// cadence + status only — never owner/repo. state.json is the latest snapshot; the per-day jsonl is an
// append-only log (R2 has no append, so read-modify-write — safe at a 10-min cadence).
async function writeState(env: Env, rec: TickRecord): Promise<void> {
  await env.STATE.put("_scheduler/state.json", JSON.stringify(rec, null, 2), {
    httpMetadata: { contentType: "application/json" },
  }).catch((e) => console.error(`state.json put failed: ${String(e)}`));

  const key = `_scheduler/log/${rec.tick.slice(0, 10)}.jsonl`; // YYYY-MM-DD
  try {
    const existing = await env.STATE.get(key);
    const prior = existing ? await existing.text() : "";
    await env.STATE.put(key, prior + JSON.stringify(rec) + "\n", {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  } catch (e) {
    console.error(`log append failed (${key}): ${String(e)}`);
  }
}

// Manual endpoint for validating the dispatch path end-to-end before cutover, plus liveness/state reads.
async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") return new Response("ok\n"); // open liveness

  if (req.headers.get("X-Trigger-Secret") !== env.TRIGGER_SECRET) {
    return new Response("forbidden\n", { status: 403 });
  }

  if (url.pathname === "/state") {
    const obj = await env.STATE.get("_scheduler/state.json");
    if (!obj) return new Response("no state yet\n", { status: 404 });
    return new Response(obj.body, { headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/trigger") {
    const cadence = url.searchParams.get("cadence");
    if (!isCadence(cadence)) {
      return new Response(`missing/invalid ?cadence (one of: ${ALL_CADENCES.join(", ")})\n`, { status: 400 });
    }
    const clients = safeParseClients(env);
    if (!clients) return new Response("CLIENTS secret is not valid JSON\n", { status: 500 });
    const onlyId = url.searchParams.get("client");
    const targets = clients.filter((c) => !onlyId || c.id === onlyId);
    if (targets.length === 0) return new Response("no matching client\n", { status: 404 });
    const now = new Date();
    const results = await fanOut(env, [cadence], targets);
    await writeState(env, toTickRecord(now, [cadence], results));
    return Response.json({ cadence, fired: targets.map((c) => c.id), results });
  }

  return new Response("not found\n", { status: 404 });
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const t = new Date(event.scheduledTime); // intended tick instant (UTC)
    const cadences = dueCadences(t);
    const clients = safeParseClients(env);
    if (!clients) return; // bad roster — logged; nothing to dispatch
    const results = await fanOut(env, cadences, clients);
    await writeState(env, toTickRecord(t, cadences, results));
    const fired = results.filter((r) => r.status !== 0).length;
    console.log(`tick ${t.toISOString()} cron=${event.cron} cadences=[${cadences.join(",")}] dispatches=${fired}`);
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    return handleFetch(req, env);
  },
} satisfies ExportedHandler<Env>;
