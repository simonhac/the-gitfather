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
// Auth is a GitHub App, NOT a long-lived PAT. The Worker holds only the App private key (GH_APP_PRIVATE_KEY)
// + id (GH_APP_ID); per dispatch it signs a short-lived RS256 JWT and mints a 1h installation token,
// down-scoped to { actions: write } on just that client's repo. No token to expire (no silent-stop failure
// mode) and the blast radius is actions:write on the installed repos only — see getInstallationToken().
//
// Client identifiers (owner/repo) are NEVER in source — they live in the CLIENTS secret. Logs written
// to the shared (public) dashboard bucket carry only opaque ids, never owner/repo. See README.md.
// ─────────────────────────────────────────────────────────────────────────────

export interface Env {
  GH_APP_ID: string; // secret: GitHub App id — the `iss` of the JWT we sign to mint installation tokens
  GH_APP_PRIVATE_KEY: string; // secret: the App private key as a PKCS#8 PEM ("BEGIN PRIVATE KEY"). GitHub
  // issues PKCS#1 ("BEGIN RSA PRIVATE KEY"); convert ONCE with `openssl pkcs8 -topk8 -nocrypt` — WebCrypto's
  // importKey takes pkcs8 only, and a PKCS#1 key fails to import. See README "GitHub App setup".
  CLIENTS: string; // secret: JSON roster (see Client[] below) — keeps repo names + installation ids out of source
  TRIGGER_SECRET: string; // secret: shared secret gating the manual /trigger and /state endpoints
  STATE: R2Bucket; // binding: shared dashboard bucket (free, in-network) — scheduler state + logs
}

type Cadence = "backup" | "staleness" | "durableVerify" | "restoreDrill";

interface Client {
  id: string; // opaque label — the ONLY client identifier that may appear in logs
  owner: string;
  repo: string;
  installationId: number; // the GitHub App's installation id on this owner's account (not secret; rides in CLIENTS)
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

// ── GitHub App auth ──────────────────────────────────────────────────────────────────────────────────
// Instead of a long-lived PAT, we authenticate as a GitHub App: sign a short-lived RS256 JWT with the App
// private key, exchange it for a 1h *installation* token scoped to one repo + actions:write, and use that
// to dispatch. There is no token to expire (no silent-stop failure mode), and a leaked key/token can only
// reach actions:write on the installed repos — never source, secrets, or other repos.

const GH_API = "https://api.github.com";
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "gitfather-scheduler", // GitHub rejects requests with no User-Agent
};

// base64url (no padding) of raw bytes — used for every JWT segment. Buffers here are tiny (<256B).
function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

// Strip PEM armor + whitespace, base64-decode the body to the DER bytes importKey('pkcs8', …) expects.
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const der = atob(body);
  const buf = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) buf[i] = der.charCodeAt(i);
  return buf.buffer;
}

// A GitHub App JWT: iss = App id, iat backdated 60s for clock drift, exp +9 min (under GitHub's 10-min ceiling).
async function mintAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({ iat: now - 60, exp: now + 540, iss: env.GH_APP_ID })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GH_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
// Per-isolate, best-effort cache. A cold isolate (or a concurrent one) simply re-mints — correctness never
// depends on this; it only spares us a mint on every */10 tick. Keyed by installation id.
const tokenCache = new Map<number, CachedToken>();

// Mint (or reuse) a 1h installation token, down-scoped to this client's repo + actions:write. Throws on any
// non-201 so the caller (dispatch) records it as a failed dispatch rather than silently sending no auth.
async function getInstallationToken(env: Env, c: Client): Promise<string> {
  const cached = tokenCache.get(c.installationId);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60_000) return cached.token; // refresh 5 min early

  const jwt = await mintAppJwt(env);
  const res = await fetch(`${GH_API}/app/installations/${c.installationId}/access_tokens`, {
    method: "POST",
    headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    // Down-scope below the installation grant: just this repo, just actions:write (all workflow_dispatch needs).
    body: JSON.stringify({ repositories: [c.repo], permissions: { actions: "write" } }),
  });
  if (res.status !== 201) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    // 401 bad/expired JWT (often clock skew) · 404 wrong installationId / app not installed · 422 bad scope request.
    throw new Error(`token mint failed ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { token?: string; expires_at?: string };
  if (typeof json.token !== "string" || json.token.length === 0) {
    throw new Error("token mint returned 201 with no token field"); // fail loudly here, not as `Bearer undefined` later
  }
  // A missing/invalid expires_at parses to NaN; the cache check (NaN - now > …) is then always false, so we simply
  // re-mint next time — safe, no reason to reject an otherwise-valid token over a bad timestamp.
  tokenCache.set(c.installationId, { token: json.token, expiresAtMs: Date.parse(json.expires_at ?? "") });
  return json.token;
}

function parseClients(env: Env): Client[] {
  const raw: unknown = JSON.parse(env.CLIENTS);
  if (!Array.isArray(raw)) throw new Error("CLIENTS secret must be a JSON array");
  const clients = raw as Client[];
  for (const c of clients) {
    // installationId is required but the roster is otherwise unvalidated JSON. Catch a bad/missing one HERE with a
    // clear message, not as a cryptic 404 on POST /app/installations/undefined/access_tokens at dispatch time.
    if (typeof c.installationId !== "number" || !Number.isInteger(c.installationId) || c.installationId <= 0) {
      throw new Error(`CLIENTS entry "${c.id ?? "?"}" needs a positive integer installationId (got ${JSON.stringify(c.installationId)})`);
    }
  }
  return clients;
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
  const url = `${GH_API}/repos/${c.owner}/${c.repo}/actions/workflows/${file}/dispatches`;
  try {
    const token = await getInstallationToken(env, c); // throws on mint failure → caught below as status -1
    const res = await fetch(url, {
      method: "POST",
      headers: { ...GH_HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: REF, inputs: inputsFor(cadence) }),
    });
    if (res.status === 204) {
      console.log(`dispatch ok: ${c.id}/${cadence} -> ${file}`);
      return { id: c.id, cadence, status: 204 };
    }
    // 401 bad token · 403 token lacks Actions:write (or rate-limited) · 404 wrong repo/file or the caller
    // lacks a workflow_dispatch trigger · 422 unknown input. (A bad App key/installation surfaces earlier as
    // a thrown mint error → status -1 below, NOT here, since we never reach fetch without a minted token.)
    const body = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`dispatch FAIL ${res.status}: ${c.id}/${cadence} ${file} :: ${body}`);
    return { id: c.id, cadence, status: res.status, error: body };
  } catch (e) {
    // includes installation-token mint failures (bad/expired JWT from clock skew, wrong installationId, app
    // uninstalled, actions:write not granted) as well as network errors — all logged, none silent.
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

// The dashboard bucket is PUBLIC. The full r.error (a GitHub API response body) stays in the Worker console and
// the secret-gated /trigger response; the persisted record carries only a generic, status-derived code so we
// never write free-form upstream text to a public object (honours the "opaque ids only" guarantee above).
function publicErrorCode(status: number): string {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 422:
      return "unprocessable";
    case -1:
      return "mint_or_network_error";
    default:
      return "dispatch_failed";
  }
}

function toTickRecord(t: Date, cadences: Cadence[], results: DispatchResult[]): TickRecord {
  return {
    tick: t.toISOString(),
    cadences,
    dispatches: results
      .filter((r) => r.status !== 0) // drop "not subscribed" no-ops
      .map((r) => ({ id: r.id, cadence: r.cadence, status: r.status, ...(r.error ? { error: publicErrorCode(r.status) } : {}) })),
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
