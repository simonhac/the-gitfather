// ─────────────────────────────────────────────────────────────────────────────
// Read-only client probes for `doctor` — "is this consumer actually wired up?".
//
// Each probe answers one question about an EXTERNAL dependency (a binary, the R2
// bucket, a Postgres endpoint, Slack, gh) and returns a {name, ok, detail} verdict.
// Everything here is strictly read-only: `rclone lsf`, `psql 'select 1'`, Slack
// `auth.test`, `gh auth status`, `--version`. No dump, no upload, no workflow trigger,
// no Slack post — doctor must be safe to run against production creds.
//
// Built on commandExists()/capture() from proc.ts (capture never throws and bounds its
// output). Network probes fail FAST (short rclone/psql/fetch timeouts) so a wrong host
// reports "unreachable" instead of hanging the preflight.
// ─────────────────────────────────────────────────────────────────────────────

import { capture, commandExists } from "./proc.js";
import { pgConn } from "./pgconn.js";

export interface ProbeResult {
  /** Short label shown in the checklist, e.g. "rclone" or "Postgres (backup source)". */
  name: string;
  ok: boolean;
  /** One-line human detail — a version, an object count, or why it failed. Never a secret. */
  detail: string;
  /** Optional probes warn (⚠) on failure instead of failing the whole preflight. */
  optional?: boolean;
}

/** Configure an rclone S3 remote purely from env (no rclone.conf), mirroring the tasks. */
export function configureRcloneRemote(remote: string, accountId: string, key: string, secret: string): void {
  const R = `RCLONE_CONFIG_${remote.toUpperCase()}`;
  process.env[`${R}_TYPE`] = "s3";
  process.env[`${R}_PROVIDER`] = "Cloudflare";
  process.env[`${R}_ACCESS_KEY_ID`] = key;
  process.env[`${R}_SECRET_ACCESS_KEY`] = secret;
  process.env[`${R}_ENDPOINT`] = `https://${accountId}.r2.cloudflarestorage.com`;
}

/** Is `cmd` on PATH? */
export function checkBinary(cmd: string, optional = false): ProbeResult {
  const ok = commandExists(cmd);
  return { name: `binary: ${cmd}`, ok, detail: ok ? "found on PATH" : "not found on PATH", optional };
}

/** Extract the major version from a `pg_dump --version` line, e.g. "pg_dump (PostgreSQL) 17.2" → 17. */
export function parsePgMajor(versionOutput: string): number | null {
  // Drop "(PostgreSQL)" so its digits can't be mistaken for the version, then take the first number.
  const m = /(\d+)/.exec(versionOutput.replace(/\(postgresql\)/i, ""));
  return m ? Number(m[1]) : null;
}

/** `bin` (pg_dump/pg_restore) major version ≥ `minMajor` (a client older than the server can't dump it). */
export function checkPgClientVersion(minMajor: number, bin = "pg_dump"): ProbeResult {
  const name = `${bin} version ≥ ${minMajor}`;
  const res = capture(bin, ["--version"]);
  if (!res.ok) return { name, ok: false, detail: `${bin} not found / failed to run` };
  const major = parsePgMajor(res.out);
  if (major === null) return { name, ok: false, detail: `could not parse version from '${res.out.trim()}'` };
  return { name, ok: major >= minMajor, detail: `found ${bin} ${major} (need ≥ ${minMajor})` };
}

/**
 * The R2 remote+bucket is reachable and the creds authorize a listing. Assumes the
 * RCLONE_CONFIG_<remote>_* env is already set (see configureRcloneRemote). Read-only.
 */
export function checkR2(remote: string, bucket: string, label = "R2"): ProbeResult {
  const name = `${label} (${remote}:${bucket})`;
  const res = capture("rclone", [
    "lsf",
    "--max-depth",
    "1",
    `${remote}:${bucket}/`,
    "--s3-no-check-bucket",
    "--timeout=20s",
    "--contimeout=10s",
    "--low-level-retries=1",
    "--retries=1",
  ]);
  if (!res.ok) return { name, ok: false, detail: "rclone lsf failed (check creds / bucket / endpoint)" };
  const n = res.out.split("\n").filter((s) => s.trim()).length;
  return { name, ok: true, detail: `reachable (${n} entr${n === 1 ? "y" : "ies"} at top level)` };
}

/** A Postgres URL accepts a connection and runs `select 1`. Read-only; 10s connect timeout. */
export function checkPostgres(url: string, label: string): ProbeResult {
  const name = `Postgres (${label})`;
  if (!commandExists("psql")) return { name, ok: false, detail: "psql not found on PATH" };
  // Keep the password off psql's argv — it rides in a temp 0600 PGPASSFILE.
  const conn = pgConn(url);
  try {
    const res = capture("psql", [conn.safeUrl, "-tAc", "select 1"], { ...conn.env, PGCONNECT_TIMEOUT: "10" });
    const ok = res.ok && res.out.replace(/\s/g, "") === "1";
    return { name, ok, detail: ok ? "connected, select 1 ok" : "connection / auth failed" };
  } finally {
    conn.cleanup();
  }
}

/** Slack token is valid (auth.test). Read-only — posts nothing. */
export async function checkSlack(token: string, channel: string): Promise<ProbeResult> {
  const name = "Slack (auth.test)";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
    });
    const body = (await res.json()) as { ok?: boolean; error?: string; team?: string };
    if (body.ok) {
      return { name, ok: true, detail: `authorized${body.team ? ` (team ${body.team})` : ""}, channel ${channel}` };
    }
    return { name, ok: false, detail: `auth.test failed: ${body.error ?? "unknown error"}` };
  } catch (e) {
    return { name, ok: false, detail: `request failed: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** gh is installed and authenticated (needed for staleness self-heal). Read-only. */
export function checkGh(repo?: string): ProbeResult {
  const name = "gh (self-heal)";
  if (!commandExists("gh")) return { name, ok: false, detail: "gh not found on PATH", optional: true };
  const res = capture("gh", ["auth", "status"]);
  if (!res.ok) return { name, ok: false, detail: "gh not authenticated (`gh auth status` failed)", optional: true };
  return { name, ok: true, detail: repo ? `authenticated (repo ${repo})` : "authenticated", optional: true };
}
