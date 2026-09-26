import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { pgConn, withDatabase } from "../lib/pgconn.js";

test("pgConn: strips the password from the URL but keeps user/host/port/db/sslmode", () => {
  const c = pgConn("postgres://u:s3cr3t@db.example.com:5432/app?sslmode=require");
  try {
    assert.ok(!c.safeUrl.includes("s3cr3t"), "password must not be on the (argv-bound) URL");
    assert.match(c.safeUrl, /^postgres:\/\/u@db\.example\.com:5432\/app\?sslmode=require$/);
  } finally {
    c.cleanup();
  }
});

test("pgConn: password goes into a 0600 PGPASSFILE (off the environment too)", () => {
  const c = pgConn("postgresql://u:p%40ss@h/app"); // %40 = '@', exercises URL-decoding
  try {
    const f = c.env.PGPASSFILE!;
    assert.ok(f && existsSync(f), "PGPASSFILE should be written");
    assert.equal(statSync(f).mode & 0o777, 0o600, "pgpass must be 0600");
    assert.equal(readFileSync(f, "utf8"), "*:*:*:*:p@ss\n");
  } finally {
    c.cleanup();
  }
});

test("pgConn: cleanup removes the temp file", () => {
  const c = pgConn("postgres://u:pw@h/db");
  const f = c.env.PGPASSFILE!;
  assert.ok(existsSync(f));
  c.cleanup();
  assert.ok(!existsSync(f), "cleanup should remove the pgpass file");
});

test("pgConn: escapes backslash and colon in the password", () => {
  const c = pgConn("postgres://u:a%3Ab%5Cc@h/db"); // %3A=':', %5C='\'  → password a:b\c
  try {
    assert.equal(readFileSync(c.env.PGPASSFILE!, "utf8"), "*:*:*:*:a\\:b\\\\c\n");
  } finally {
    c.cleanup();
  }
});

test("pgConn: a URL with no password is returned unchanged and adds no PGPASSFILE", () => {
  // Guard against an ambient PGPASSFILE: the no-password branch passes process.env through, so we
  // assert it doesn't INTRODUCE one rather than depending on the runner's environment.
  const prev = process.env.PGPASSFILE;
  delete process.env.PGPASSFILE;
  try {
    const c = pgConn("postgres://u@h/db");
    assert.equal(c.safeUrl, "postgres://u@h/db");
    assert.equal(c.env.PGPASSFILE, undefined);
    c.cleanup(); // no-op
  } finally {
    if (prev === undefined) delete process.env.PGPASSFILE;
    else process.env.PGPASSFILE = prev;
  }
});

test("withDatabase: swaps the database, preserving user/host/port/query", () => {
  assert.equal(
    withDatabase("postgres://u:pw@localhost:5432/postgres?sslmode=disable", "gitfather_drill"),
    "postgres://u:pw@localhost:5432/gitfather_drill?sslmode=disable",
  );
  // no prior path, no query → still yields a clean single-segment path
  assert.equal(withDatabase("postgres://u:pw@h:5432/app", "postgres"), "postgres://u:pw@h:5432/postgres");
});

test("pgConn: a literal '%' in the password does not throw (URIError) and round-trips raw", () => {
  // `new URL()` accepts p%ss (config validation passes); decodeURIComponent would throw on it.
  const c = pgConn("postgres://u:p%ss@h/db");
  try {
    assert.ok(!c.safeUrl.includes("p%ss"), "password must not be on the URL");
    assert.equal(readFileSync(c.env.PGPASSFILE!, "utf8"), "*:*:*:*:p%ss\n");
  } finally {
    c.cleanup();
  }
});

// ── An ambient PGSSLROOTCERT must not override the URL's stated sslmode ──────
// libpq refuses `sslrootcert=system` with any sslmode below verify-ca, so an env var the caller
// never set makes the tool decline to connect at all. The URL is the caller's intent; env is not.

const sslEnv = (url: string): NodeJS.ProcessEnv => {
  const prev = process.env.PGSSLROOTCERT;
  process.env.PGSSLROOTCERT = "system";
  try {
    return pgConn(url).env;
  } finally {
    if (prev === undefined) delete process.env.PGSSLROOTCERT;
    else process.env.PGSSLROOTCERT = prev;
  }
};

test("pgConn drops PGSSLROOTCERT=system for the sslmodes libpq refuses to pair it with", () => {
  for (const mode of ["disable", "allow", "prefer", "require"]) {
    assert.equal(
      sslEnv(`postgresql://u:p@h:5432/db?sslmode=${mode}`).PGSSLROOTCERT,
      undefined,
      `sslmode=${mode} must not keep sslrootcert=system`,
    );
  }
});

test("pgConn KEEPS PGSSLROOTCERT=system when the URL actually verifies", () => {
  // Dropping it here would silently weaken a connection that asked to be verified — the opposite
  // failure, and a much worse one than an error message.
  for (const mode of ["verify-ca", "verify-full"]) {
    assert.equal(sslEnv(`postgresql://u:p@h:5432/db?sslmode=${mode}`).PGSSLROOTCERT, "system", mode);
  }
});

test("pgConn leaves PGSSLROOTCERT alone when the URL names no sslmode, and when it is not 'system'", () => {
  assert.equal(sslEnv("postgresql://u:p@h:5432/db").PGSSLROOTCERT, "system", "no sslmode → no opinion");
  const prev = process.env.PGSSLROOTCERT;
  process.env.PGSSLROOTCERT = "/etc/ssl/my-root.crt";
  try {
    assert.equal(pgConn("postgresql://u:p@h:5432/db?sslmode=require").env.PGSSLROOTCERT, "/etc/ssl/my-root.crt");
  } finally {
    if (prev === undefined) delete process.env.PGSSLROOTCERT;
    else process.env.PGSSLROOTCERT = prev;
  }
});

test("pgConn applies the same rule to a passwordless URL (the early-return path)", () => {
  assert.equal(sslEnv("postgresql://localhost:5432/postgres?sslmode=disable").PGSSLROOTCERT, undefined);
});
