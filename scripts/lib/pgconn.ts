// ─────────────────────────────────────────────────────────────────────────────
// Keep the Postgres PASSWORD off the process table (and out of the environment).
//
// psql/pg_dump/pg_restore historically took the full `postgres://user:pw@host/db` URL on the
// argv, where the password is visible to any `ps`/`/proc/<pid>/cmdline` reader. pgConn() splits
// that: the password goes into a private 0600 `PGPASSFILE` (referenced via env), and the tools get
// the SAME URL with the password stripped — user/host/port/db/query-params are not secret, so they
// can stay on the argv. libpq reads the password from PGPASSFILE at connect time.
//
//   const conn = pgConn(url, tmpDir);
//   capture("psql", [conn.safeUrl, "-tAc", "select 1"], conn.env);
//   // …password never appears on a child's argv NOR in its inherited environment.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PgConn {
  /** The connection URL with the password removed — safe to put on a child's argv. */
  safeUrl: string;
  /** Child environment carrying PGPASSFILE (a shallow copy of process.env; merge extras on top). */
  env: NodeJS.ProcessEnv;
  /** Remove the temp pgpass file (and the temp dir if pgConn created one). Safe to call once. */
  cleanup: () => void;
}

/** Escape a password for a .pgpass line: backslash and colon are the only metacharacters. */
function escapePgpass(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/** The sslmodes libpq refuses to combine with `sslrootcert=system` — everything below verify-ca. */
const WEAK_SSLMODES = new Set(["disable", "allow", "prefer", "require"]);

/**
 * Drop an ambient `PGSSLROOTCERT=system` when the URL asks for an sslmode weaker than verify-ca.
 *
 * libpq rejects that pairing outright — `weak sslmode "disable" may not be used with
 * sslrootcert=system` — so an environment variable the caller never set silently overrides the
 * sslmode they explicitly wrote in the connection string, and the tool refuses to connect at all.
 * The URL is the caller's stated intent; ambient env is not. This is the same reason the password
 * is taken off the argv here rather than trusted to the environment.
 *
 * Only the incompatible combination is cleared: a URL asking for verify-ca/verify-full still gets
 * the root cert it needs.
 */
function withoutConflictingSslRootCert(env: NodeJS.ProcessEnv, url: string): NodeJS.ProcessEnv {
  if (env.PGSSLROOTCERT !== "system") return env;
  let sslmode: string | null;
  try {
    sslmode = new URL(url).searchParams.get("sslmode");
  } catch {
    return env;
  }
  if (!sslmode || !WEAK_SSLMODES.has(sslmode)) return env;
  const rest = { ...env };
  delete rest.PGSSLROOTCERT;
  return rest;
}

let seq = 0; // unique pgpass filenames when several pgConn() share one caller dir

/**
 * Decompose `url` so the password rides in a 0600 PGPASSFILE rather than on the argv. Pass `dir` to
 * write the pgpass inside a scratch dir the caller already cleans (cleanup() then just unlinks the
 * file); omit it and pgConn makes its own temp dir (cleanup() removes the whole dir). When the URL
 * carries no password, no file is written and `safeUrl` is the URL unchanged.
 */
export function pgConn(url: string, dir?: string): PgConn {
  const u = new URL(url);
  // A password with a literal '%' (not a valid %-escape) makes decodeURIComponent throw URIError — and
  // such a URL passes config validation (new URL() accepts it). Fall back to the raw bytes, which is
  // what the operator typed and what libpq's pgpass expects, rather than crashing mid-run.
  let password: string;
  try {
    password = decodeURIComponent(u.password);
  } catch {
    password = u.password;
  }
  if (!password) {
    return { safeUrl: url, env: withoutConflictingSslRootCert(process.env, url), cleanup: () => {} };
  }
  u.password = "";
  const safeUrl = u.toString();

  const ownDir = dir === undefined;
  const base = dir ?? mkdtempSync(join(tmpdir(), "pgpass-"));
  const passFile = join(base, `.pgpass-${process.pid}-${seq++}`);
  // `*:*:*:*:<pw>` — a single fresh file per call, so the wildcard match is unambiguous.
  writeFileSync(passFile, `*:*:*:*:${escapePgpass(password)}\n`, { mode: 0o600 });

  const cleanup = (): void => {
    try {
      if (ownDir) rmSync(base, { recursive: true, force: true });
      else unlinkSync(passFile);
    } catch {
      /* best-effort temp cleanup */
    }
  };

  return { safeUrl, env: withoutConflictingSslRootCert({ ...process.env, PGPASSFILE: passFile }, url), cleanup };
}

/**
 * Return `url` with its database (the URL path) replaced by `db`, preserving user/host/port/query.
 * Used by the restore drill to derive a maintenance connection (→ `postgres`) and a scratch-DB
 * connection from one configured drill URL. Feed the result to pgConn() to keep the password off argv.
 */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
