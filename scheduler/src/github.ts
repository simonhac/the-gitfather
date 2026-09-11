// ─────────────────────────────────────────────────────────────────────────────
// GitHub App auth + the two Actions API calls the Worker makes: dispatch a workflow, list its runs.
//
// Instead of a long-lived PAT, we authenticate as a GitHub App: sign a short-lived RS256 JWT with the App
// private key, exchange it for a 1h *installation* token scoped to one repo + actions:write, and use that
// for every call. There is no token to expire (no silent-stop failure mode), and a leaked key/token can
// only reach actions:write on the installed repos — never source, secrets, or other repos. The App has
// NO contents permission: config flows GitHub → Cloudflare (the backup publishes it), never the reverse.
//
// Client identifiers (owner/repo) are NEVER in source — they live in the ROSTER var of the (gitignored)
// wrangler.jsonc. Logs written to the shared (public) dashboard bucket carry only opaque ids.
// ─────────────────────────────────────────────────────────────────────────────

export interface Env {
  GH_APP_ID: string; // secret: GitHub App id — the `iss` of the JWT we sign to mint installation tokens
  GH_APP_PRIVATE_KEY: string; // secret: the App private key as a PKCS#8 PEM ("BEGIN PRIVATE KEY"). GitHub
  // issues PKCS#1 ("BEGIN RSA PRIVATE KEY"); convert ONCE with `openssl pkcs8 -topk8 -nocrypt` — WebCrypto's
  // importKey takes pkcs8 only, and a PKCS#1 key fails to import. See README "GitHub App setup".
  TRIGGER_SECRET: string; // secret: shared secret gating the manual /trigger and /state endpoints
  SLACK_BOT_TOKEN?: string; // secret: the watchdog's bot token (chat:write); per-client override SLACK_BOT_TOKEN_<ID>
  SCHEDULER_HEARTBEAT_URL?: string; // secret: BetterStack heartbeat, pinged when a TICK DELIVERED (see health.ts).
  // UNSET MEANS OFF, so `wrangler dev` and a preview deployment can never keep production's monitor green.
  ROSTER: Client[] | string; // var (wrangler.jsonc): the client roster — see Client. A JSON string is accepted too.
  STATE: R2Bucket; // binding: shared dashboard bucket (free, in-network) — scheduler state + logs
  // Plus, per client: its private dump bucket under the binding named in Client.bucket, and optional
  // ALERT_WEBHOOK_URL_<ID> secrets. Typed loosely here; parseClients() checks the bindings exist.
  [binding: string]: unknown;
}

export type Cadence = "backup" | "staleness" | "durableVerify" | "restoreDrill" | "archive";

export interface Client {
  id: string; // opaque label — the ONLY client identifier that may appear in logs
  owner: string;
  repo: string;
  installationId: number; // the GitHub App's installation id on this owner's account (not secret)
  bucket: string; // the R2 binding name of this client's PRIVATE dump bucket (declared in wrangler.jsonc)
  cadences?: Cadence[]; // optional allowlist of cadences this client runs (default: all NON-opt-in ones)
  workflows?: Partial<Record<Cadence, string>>; // optional per-client filename overrides (default: DEFAULT_WORKFLOWS)
}

export const ALL_CADENCES: readonly Cadence[] = ["backup", "staleness", "durableVerify", "restoreDrill", "archive"];

// the-gitfather's conventional caller-workflow filenames. They're identical across consuming repos by
// convention, so they live here as defaults rather than being repeated for every client in the roster.
// `staleness` has no caller any more — it runs natively (watchdog.ts) — but stays a cadence so a client
// can opt out of it via `cadences`, and so `/trigger?cadence=staleness` fires it on demand.
export const DEFAULT_WORKFLOWS: Record<Exclude<Cadence, "staleness">, string> = {
  backup: "pg-backup.yml",
  durableVerify: "pg-durable-verify.yml",
  restoreDrill: "pg-restore-drill.yml",
  archive: "pg-archive.yml",
};

export const workflowFor = (c: Client, cadence: Exclude<Cadence, "staleness">): string =>
  c.workflows?.[cadence] ?? DEFAULT_WORKFLOWS[cadence];

// Cadences a client gets ONLY by naming them. `cadences` defaults to "everything", so a cadence added
// after clients are already in the roster MUST be opt-in — otherwise it starts dispatching to repos
// that have no such caller workflow and 404s on every tick. `archive` also deletes rows, which is not
// something any client should acquire by upgrade.
const OPT_IN_CADENCES: readonly Cadence[] = ["archive"];

export const subscribes = (c: Client, cadence: Cadence): boolean =>
  c.cadences ? c.cadences.includes(cadence) : !OPT_IN_CADENCES.includes(cadence);

export function isCadence(s: string | null): s is Cadence {
  return s !== null && (ALL_CADENCES as readonly string[]).includes(s);
}

const isR2Bucket = (v: unknown): v is R2Bucket => !!v && typeof (v as R2Bucket).list === "function";

/** Parse + validate the roster. Throws with a clear message — a bad roster must not surface as a cryptic 404 later. */
export function parseClients(env: Env): Client[] {
  const raw: unknown = typeof env.ROSTER === "string" ? JSON.parse(env.ROSTER) : env.ROSTER;
  if (!Array.isArray(raw)) throw new Error("ROSTER must be a JSON array (a `vars` entry in wrangler.jsonc)");
  const clients = raw as Client[];
  const seen = new Set<string>();
  for (const c of clients) {
    const label = `ROSTER entry "${c.id ?? "?"}"`;
    if (typeof c.id !== "string" || !c.id) throw new Error(`${label} needs a non-empty id`);
    if (seen.has(c.id)) throw new Error(`${label} is duplicated`);
    seen.add(c.id);
    if (typeof c.owner !== "string" || !c.owner || typeof c.repo !== "string" || !c.repo) throw new Error(`${label} needs owner + repo`);
    if (typeof c.installationId !== "number" || !Number.isInteger(c.installationId) || c.installationId <= 0) {
      throw new Error(`${label} needs a positive integer installationId (got ${JSON.stringify(c.installationId)})`);
    }
    if (typeof c.bucket !== "string" || !c.bucket) throw new Error(`${label} needs bucket (an R2 binding name)`);
    if (!isR2Bucket(env[c.bucket])) throw new Error(`${label}: no R2 binding named ${c.bucket} — add it to r2_buckets in wrangler.jsonc`);
  }
  return clients;
}

export function safeParseClients(env: Env): Client[] | null {
  try {
    return parseClients(env);
  } catch (e) {
    console.error(`ROSTER parse failed: ${String(e)}`);
    return null;
  }
}

// ── GitHub App auth ──────────────────────────────────────────────────────────────────────────────────

export const GH_API = "https://api.github.com";
export const GH_HEADERS = {
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
// non-201 so the caller records it as a failed call rather than silently sending no auth.
export async function getInstallationToken(env: Env, c: Client): Promise<string> {
  const cached = tokenCache.get(c.installationId);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60_000) return cached.token; // refresh 5 min early

  const jwt = await mintAppJwt(env);
  const res = await fetch(`${GH_API}/app/installations/${c.installationId}/access_tokens`, {
    method: "POST",
    headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    // Down-scope below the installation grant: just this repo, just actions:write (covers dispatch + run listing).
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

// ── Actions API ──────────────────────────────────────────────────────────────────────────────────────

export interface DispatchOutcome {
  status: number; // HTTP status from GitHub; 204 = success, -1 = token mint or network error
  error?: string;
}

/** POST a workflow_dispatch for `file` on the client's `main`. Never throws — a failure is a status + message. */
export async function dispatchWorkflow(env: Env, c: Client, file: string, inputs: Record<string, string>): Promise<DispatchOutcome> {
  const url = `${GH_API}/repos/${c.owner}/${c.repo}/actions/workflows/${file}/dispatches`;
  try {
    const token = await getInstallationToken(env, c); // throws on mint failure → caught below as status -1
    const res = await fetch(url, {
      method: "POST",
      headers: { ...GH_HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs }),
    });
    if (res.status === 204) return { status: 204 };
    // 401 bad token · 403 token lacks Actions:write (or rate-limited) · 404 wrong repo/file or the caller
    // lacks a workflow_dispatch trigger · 422 unknown input.
    const body = (await res.text().catch(() => "")).slice(0, 300);
    return { status: res.status, error: body };
  } catch (e) {
    // includes installation-token mint failures (bad/expired JWT from clock skew, wrong installationId, app
    // uninstalled, actions:write not granted) as well as network errors — all reported, none silent.
    return { status: -1, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface WorkflowRunSummary {
  status?: string; // queued | in_progress | completed
  conclusion?: string | null; // success | failure | cancelled | timed_out | startup_failure | … (null while running)
}

/** The 10 newest runs of `file`, newest first (what `gh run list --json status,conclusion` gave the old watchdog). Throws on failure. */
export async function listWorkflowRuns(env: Env, c: Client, file: string): Promise<WorkflowRunSummary[]> {
  const token = await getInstallationToken(env, c);
  const res = await fetch(`${GH_API}/repos/${c.owner}/${c.repo}/actions/workflows/${file}/runs?per_page=10`, {
    headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`run listing failed ${res.status}`);
  const body = (await res.json()) as { workflow_runs?: WorkflowRunSummary[] };
  return (body.workflow_runs ?? []).map((r) => ({ status: r.status, conclusion: r.conclusion ?? null }));
}
