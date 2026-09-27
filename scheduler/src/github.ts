// ─────────────────────────────────────────────────────────────────────────────
// GitHub App auth + the Actions API calls the Worker makes: dispatch a workflow, list its runs, and read
// a run / its jobs (to vouch for an outcome record, and to find a failed step when a run left none).
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

import { b64urlEncode as b64url, b64urlJson } from "./b64url.js";
import { parseRoster, type Client } from "./roster.js";
import type { GithubJob, GithubPort, GithubRun } from "./deliver.js";

export interface Env {
  GH_APP_ID: string; // secret: GitHub App id — the `iss` of the JWT we sign to mint installation tokens
  GH_APP_PRIVATE_KEY: string; // secret: the App private key as a PKCS#8 PEM ("BEGIN PRIVATE KEY"). GitHub
  // issues PKCS#1 ("BEGIN RSA PRIVATE KEY"); convert ONCE with `openssl pkcs8 -topk8 -nocrypt` — WebCrypto's
  // importKey takes pkcs8 only, and a PKCS#1 key fails to import. See README "GitHub App setup".
  TRIGGER_SECRET: string; // secret: shared secret gating the manual /trigger and /state endpoints
  // secret: the-gitfather Slack app's bot token (chat:write + chat:write.customize). The ONLY Slack token
  // anywhere — client repos hold none. Unset → Slack is off. Where each client's posts go, and under what
  // name/icon, is its roster `slack` block.
  SLACK_BOT_TOKEN?: string;
  // var: the OIDC audience /notify accepts (the reusable workflows request "the-gitfather"). Unset →
  // /notify refuses everything (503), and outcomes are announced by the Slack tick alone.
  NOTIFY_AUDIENCE?: string;
  ENGINE_REPO?: string; // var: owner/repo whose reusable workflows may notify (default simonhac/the-gitfather)
  SCHEDULER_HEARTBEAT_URL?: string; // secret: BetterStack heartbeat, pinged when a TICK DELIVERED (see health.ts).
  // UNSET MEANS OFF, so `wrangler dev` and a preview deployment can never keep production's monitor green.
  ROSTER: Client[] | string; // var (wrangler.jsonc): the client roster — see roster.ts. A JSON string is accepted too.
  STATE: R2Bucket; // binding: shared dashboard bucket (free, in-network) — scheduler state + logs
  // Plus, per client: its private dump bucket under the binding named in Client.bucket, and optional
  // ALERT_WEBHOOK_URL_<ID> secrets. Typed loosely here; parseClients() checks the bindings exist.
  [binding: string]: unknown;
}

export {
  ALL_CADENCES,
  DEFAULT_WORKFLOWS,
  isCadence,
  subscribes,
  workflowFor,
  type Cadence,
  type Client,
} from "./roster.js";

const isR2Bucket = (v: unknown): v is R2Bucket => !!v && typeof (v as R2Bucket).list === "function";

/** Parse + validate the roster (roster.ts), checking each client's R2 binding exists. Throws with a clear message. */
export function parseClients(env: Env): Client[] {
  return parseRoster(env.ROSTER, (binding) => isR2Bucket(env[binding]));
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

// ── Reading runs and jobs (Slack delivery — see deliver.ts) ──────────────────────────────────────────

interface ApiJob {
  id?: number;
  started_at?: string | null;
  steps?: { name?: string; conclusion?: string | null }[];
}

const toJob = (j: ApiJob): GithubJob => ({
  id: j.id ?? 0,
  startedAt: j.started_at ?? null,
  steps: (j.steps ?? []).map((s) => ({ name: s.name ?? "?", conclusion: s.conclusion ?? null })),
});

/** GET an Actions API path for this client: parsed JSON, null on 404, throws otherwise. */
async function ghGet<T>(env: Env, c: Client, path: string): Promise<T | null> {
  const token = await getInstallationToken(env, c);
  const res = await fetch(`${GH_API}/repos/${c.owner}/${c.repo}${path}`, { headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} failed ${res.status}`);
  return (await res.json()) as T;
}

/** The client's repo as deliver.ts sees it. */
export function githubPortFor(env: Env, c: Client): GithubPort {
  return {
    async getRun(runId: string): Promise<GithubRun | null> {
      const r = await ghGet<{ created_at?: string; referenced_workflows?: { path?: string }[] }>(env, c, `/actions/runs/${runId}`);
      if (!r) return null;
      return { createdAt: r.created_at ?? "", referencedWorkflows: (r.referenced_workflows ?? []).map((w) => w.path ?? "") };
    },
    async getJob(jobId: string): Promise<GithubJob | null> {
      const j = await ghGet<ApiJob>(env, c, `/actions/jobs/${jobId}`);
      return j ? toJob(j) : null;
    },
    async listRunJobs(runId: string, attempt: number): Promise<GithubJob[]> {
      const r = await ghGet<{ jobs?: ApiJob[] }>(env, c, `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
      return (r?.jobs ?? []).map(toJob);
    },
  };
}
