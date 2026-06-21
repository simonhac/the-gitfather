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
    return { safeUrl: url, env: process.env, cleanup: () => {} };
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

  return { safeUrl, env: { ...process.env, PGPASSFILE: passFile }, cleanup };
}
