// ─────────────────────────────────────────────────────────────────────────────
// Verifying GitHub Actions OIDC tokens — how a job proves to /notify that it is a real run of one of
// the-gitfather's reusable workflows, in a rostered repo, without either side storing a secret.
//
// The job asks GitHub for a short-lived JWT (its caller grants `id-token: write`), signed with
// GitHub's key. We check the signature against GitHub's published JWKS, then the claims that matter:
//   iss               GitHub's issuer
//   aud               our audience (env NOTIFY_AUDIENCE), so a token minted for anything else won't do
//   exp / nbf / iat   still valid, with a little clock skew
//   repository        a rostered owner/repo (+ repository_id, when the roster pins it)
//   job_workflow_ref  one of the engine's reusable workflows — which also says WHICH job this is
//   run_id / run_attempt / check_run_id   which run to announce
//
// The token says only "this run finished — look". Everything the Worker then posts comes from R2 and
// the GitHub API, never from the request, so the worst a replayed token can do is re-render the truth.
//
// Deliberately free of Worker types (WebCrypto + fetch only) so it is testable from the Node side.
// ─────────────────────────────────────────────────────────────────────────────

import { b64urlDecode } from "./b64url.js";
import { clientForRepository, type Client } from "./roster.js";
import type { OutcomeJob } from "../../scripts/lib/jobOutcome.js";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
/** The repo whose reusable workflows may notify. Override with env ENGINE_REPO for a fork. */
export const DEFAULT_ENGINE_REPO = "simonhac/the-gitfather";

/** The engine's reusable workflow files, by the job they run. */
export const ENGINE_WORKFLOW_FILES: Record<OutcomeJob, string> = {
  backup: "pg-backup.yml",
  durableVerify: "pg-durable-verify.yml",
  restoreDrill: "pg-restore-drill.yml",
  archive: "pg-archive.yml",
};

const SKEW_S = 60;
const MAX_LIFETIME_S = 3600;

export interface GithubClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  repository: string;
  repository_id?: string;
  job_workflow_ref: string;
  workflow_ref?: string;
  run_id: string;
  run_attempt: string;
  check_run_id?: string | number;
}

export type VerifyResult = { ok: true; claims: GithubClaims } | { ok: false; reason: string };

/** Resolves a JWT `kid` to a verification key, or null when GitHub doesn't publish it. */
export type KeyLookup = (kid: string) => Promise<CryptoKey | null>;

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

async function importJwks(body: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  const list = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return keys;
  for (const k of list as Record<string, unknown>[]) {
    if (k?.kty !== "RSA" || typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
    if (k.alg !== undefined && k.alg !== "RS256") continue;
    if (k.use !== undefined && k.use !== "sig") continue;
    try {
      // A clean JWK: only what RS256 verification needs (GitHub's also carry x5c/x5t, irrelevant here).
      keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, RS256, false, ["verify"]));
    } catch {
      /* an unimportable key is simply unavailable */
    }
  }
  return keys;
}

/**
 * GitHub's signing keys, cached per isolate. A `kid` we haven't seen triggers a refetch (GitHub rotates
 * keys), but at most once per `minRefetchMs`, so a stream of garbage tokens can't turn into a stream of
 * JWKS fetches.
 */
export function jwksKeySource(
  fetchJwks: () => Promise<unknown>,
  opts: { ttlMs?: number; minRefetchMs?: number; now?: () => number } = {},
): KeyLookup {
  const ttlMs = opts.ttlMs ?? 6 * 3600_000;
  const minRefetchMs = opts.minRefetchMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;
  let lastAttempt = -Infinity;
  return async (kid: string) => {
    const t = now();
    const fresh = t - fetchedAt < ttlMs;
    if ((!fresh || !keys.has(kid)) && t - lastAttempt >= minRefetchMs) {
      lastAttempt = t;
      try {
        const next = await importJwks(await fetchJwks());
        if (next.size > 0) {
          keys = next;
          fetchedAt = t;
        }
      } catch {
        /* keep the previous keys; the caller sees an unknown kid */
      }
    }
    return keys.get(kid) ?? null;
  };
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(b64urlDecode(segment)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verify a GitHub Actions OIDC JWT. Never throws; the reason is for the Worker log only. */
export async function verifyGithubOidc(
  token: string,
  opts: { audience: string; nowMs: number; keys: KeyLookup; issuer?: string },
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 16_384) return { ok: false, reason: "malformed token" };
  const [h, p, s] = parts;
  const header = decodeJson(h);
  if (!header) return { ok: false, reason: "malformed header" };
  if (header.alg !== "RS256") return { ok: false, reason: `alg ${String(header.alg)} not accepted` };
  if (typeof header.kid !== "string") return { ok: false, reason: "no kid" };
  const key = await opts.keys(header.kid);
  if (!key) return { ok: false, reason: "unknown kid" };
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlDecode(s);
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  const signed = await crypto.subtle.verify(RS256.name, key, sig, new TextEncoder().encode(`${h}.${p}`)).catch(() => false);
  if (!signed) return { ok: false, reason: "bad signature" };

  const c = decodeJson(p);
  if (!c) return { ok: false, reason: "malformed payload" };
  const nowS = Math.floor(opts.nowMs / 1000);
  if (c.iss !== (opts.issuer ?? GITHUB_OIDC_ISSUER)) return { ok: false, reason: "wrong issuer" };
  const aud = c.aud;
  if (!(aud === opts.audience || (Array.isArray(aud) && aud.includes(opts.audience)))) return { ok: false, reason: "wrong audience" };
  if (typeof c.exp !== "number" || typeof c.iat !== "number") return { ok: false, reason: "no exp/iat" };
  if (c.exp <= nowS - SKEW_S) return { ok: false, reason: "expired" };
  if (c.iat > nowS + SKEW_S || (typeof c.nbf === "number" && c.nbf > nowS + SKEW_S)) return { ok: false, reason: "not yet valid" };
  if (c.exp - c.iat > MAX_LIFETIME_S) return { ok: false, reason: "lifetime too long" };
  for (const k of ["repository", "job_workflow_ref", "run_id", "run_attempt"] as const) {
    if (typeof c[k] !== "string") return { ok: false, reason: `no ${k}` };
  }
  return { ok: true, claims: c as unknown as GithubClaims };
}

export interface NotifyTarget {
  client: Client;
  job: OutcomeJob;
  runId: string;
  runAttempt: number;
  /** The job's check-run id (= its job id), when the token carries it. */
  jobId: string | null;
  /** When the token was minted — the run finished just before. */
  iatMs: number;
}

export type TargetResult = { ok: true; target: NotifyTarget } | { ok: false; error: "not_rostered" | "repository_id" | "not_engine_workflow" | "bad_claims" };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Map verified claims to a rostered client and one of the engine's jobs. */
export function resolveNotifyTarget(claims: GithubClaims, clients: readonly Client[], engineRepo: string = DEFAULT_ENGINE_REPO): TargetResult {
  const client = clientForRepository(clients, claims.repository);
  if (!client) return { ok: false, error: "not_rostered" };
  if (client.repositoryId !== undefined && String(claims.repository_id ?? "") !== String(client.repositoryId)) {
    return { ok: false, error: "repository_id" };
  }
  const files = Object.entries(ENGINE_WORKFLOW_FILES) as [OutcomeJob, string][];
  const m = new RegExp(`^${escapeRe(engineRepo)}/\\.github/workflows/([a-z0-9-]+\\.ya?ml)@.+$`, "i").exec(claims.job_workflow_ref);
  const job = m ? files.find(([, f]) => f === m[1].toLowerCase().replace(/\.yaml$/, ".yml"))?.[0] : undefined;
  if (!job) return { ok: false, error: "not_engine_workflow" };
  if (!/^\d{1,20}$/.test(claims.run_id) || !/^\d{1,5}$/.test(claims.run_attempt) || Number(claims.run_attempt) < 1) {
    return { ok: false, error: "bad_claims" };
  }
  const checkRun = String(claims.check_run_id ?? ""); // documented as a string claim; tolerate a number
  const jobId = /^\d{1,20}$/.test(checkRun) ? checkRun : null;
  return { ok: true, target: { client, job, runId: claims.run_id, runAttempt: Number(claims.run_attempt), jobId, iatMs: claims.iat * 1000 } };
}
