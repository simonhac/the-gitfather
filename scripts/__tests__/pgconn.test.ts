import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { pgConn } from "../lib/pgconn.js";

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

test("pgConn: a URL with no password is returned unchanged, with no PGPASSFILE", () => {
  const c = pgConn("postgres://u@h/db");
  assert.equal(c.safeUrl, "postgres://u@h/db");
  assert.equal(c.env.PGPASSFILE, undefined);
  c.cleanup(); // no-op
});
