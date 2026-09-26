// ─────────────────────────────────────────────────────────────────────────────
// verifyDumpFile() against a REAL Postgres — the keyless half of a drill.
//
// The point of this file is the property CB-303 rests on: a dump can be proved to restore with NO
// decrypt key anywhere in scope. verifyDumpFile takes a plaintext dump FILE, so the backup job can
// run these same gates on its own output BEFORE encrypting it, and CI never has to hold AGE_IDENTITY.
// A unit test cannot show that — only a real pg_restore into a real server can.
//
// It builds its own tiny source database, dumps it, and verifies the dump. No R2, no age, no
// production data. It creates and drops its OWN scratch databases and touches nothing else.
//
// Skips (rather than fails) when no Postgres is reachable. Point it somewhere with:
//   DRILL_TEST_DATABASE_URL=postgresql://localhost:5432/postgres?sslmode=disable npm test
//
// NOTE the scratch database verifyDumpFile restores INTO is `gitfather_drill`, which it drops and
// recreates. That name is fixed in restore-drill-pg.ts; do not point this at a server holding one
// you care about.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDumpFile, type DumpVerifyConfig } from "../restore-drill-pg.js";

const ADMIN_URL = process.env.DRILL_TEST_DATABASE_URL ?? "postgresql://localhost:5432/postgres?sslmode=disable";
const SRC_DB = `gf_drill_src_${process.pid}`;

// Cleared for the psql/pg_dump calls THIS FILE makes directly — a `PGSSLROOTCERT=system` in the
// ambient environment makes libpq refuse sslmode=disable outright. The calls verifyDumpFile makes
// need no help: pgConn drops the same variable for the same reason, which this test also exercises
// by not clearing it process-wide.
const PG_ENV = { ...process.env, PGSSLROOTCERT: "" };

function psql(url: string, sql: string): string {
  return execFileSync("psql", [url, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    env: PG_ENV,
  }).trim();
}

function unavailable(): string | false {
  try {
    psql(ADMIN_URL, "select 1");
    return false;
  } catch (e) {
    return `no Postgres reachable at ${ADMIN_URL} (${(e as Error).message.split("\n")[0]}) — set DRILL_TEST_DATABASE_URL`;
  }
}
const skip = unavailable();

// A silent skip is how `archive-integration.test.ts` came to look covered while never running
// anywhere. Say it on stderr too, so a green run that proved nothing cannot read as one that did.
if (skip) process.stderr.write(`\n!! verify-dump-file-integration SKIPPED: ${skip}\n\n`);

const urlFor = (db: string): string => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

/** The sentinel table's row count; `organisations` and `history` mirror Boost's nonempty gates. */
const PEOPLE = 703;

function seedSource(): void {
  psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)`);
  psql(ADMIN_URL, `CREATE DATABASE ${SRC_DB}`);
  psql(
    urlFor(SRC_DB),
    `CREATE TABLE people (id int primary key, name text);
     INSERT INTO people SELECT g, 'p' || g FROM generate_series(1, ${PEOPLE}) g;
     CREATE TABLE organisations (id int primary key);
     INSERT INTO organisations SELECT g FROM generate_series(1, 246) g;
     CREATE TABLE history (id int primary key);
     INSERT INTO history SELECT g FROM generate_series(1, 2097) g;
     CREATE TABLE tags (id int primary key);`,
  );
}

function dumpSource(dir: string): string {
  const out = join(dir, "source.dump");
  execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-privileges", "-f", out, urlFor(SRC_DB)], { env: PG_ENV });
  return out;
}

/** Boost's own drill gates, minus everything verifyDumpFile is not allowed to see. */
function cfg(): DumpVerifyConfig {
  return {
    drillDatabaseUrl: ADMIN_URL,
    liveDatabaseUrl: urlFor(SRC_DB),
    rowCountTable: "people",
    presentTables: ["tags"],
    nonemptyTables: ["organisations", "history"],
    minRowRatio: 0.95,
    maxRowRatio: 2.0,
    maxRowDrop: 0,
  };
}

test("verifyDumpFile proves a dump restores with NO decrypt key in scope", { skip }, async () => {
  seedSource();
  const dir = mkdtempSync(join(tmpdir(), "gf-drill-test-"));
  try {
    const res = await verifyDumpFile({
      dumpPath: dumpSource(dir),
      gate: "live-ratio",
      cfg: cfg(),
      tmp: dir,
      refCount: PEOPLE,
    });
    assert.equal(res.reason, null);
    assert.equal(res.ok, true);
    assert.equal(res.counts.people, PEOPLE, "the sentinel count comes from the RESTORE, not the source");
    assert.equal(res.counts.organisations, 246);
    assert.equal(res.counts.history, 2097);
    assert.equal(res.ratio, 1, "restored == dump-time reference");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)`);
  }
});

test("verifyDumpFile does not delete the dump it was handed — the caller owns it", { skip }, async () => {
  // The backup job will pass its own pre-encryption plaintext, which it still has to encrypt and
  // upload afterwards. A verify that consumed the file would break that caller and nothing else.
  seedSource();
  const dir = mkdtempSync(join(tmpdir(), "gf-drill-test-"));
  try {
    const dumpPath = dumpSource(dir);
    const before = statSync(dumpPath).size;
    await verifyDumpFile({ dumpPath, gate: "live-ratio", cfg: cfg(), tmp: dir, refCount: PEOPLE });
    assert.equal(statSync(dumpPath).size, before, "dump must survive verification unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)`);
  }
});

test("verifyDumpFile FAILS a truncated dump rather than passing a partial restore", { skip }, async () => {
  // The gate that matters: min-bytes would wave a mostly-complete dump through, and a restore of
  // one is not an error in pg_restore's eyes for every truncation point. Prove it goes red.
  seedSource();
  const dir = mkdtempSync(join(tmpdir(), "gf-drill-test-"));
  try {
    const dumpPath = dumpSource(dir);
    truncateSync(dumpPath, Math.floor(statSync(dumpPath).size * 0.6));
    const res = await verifyDumpFile({ dumpPath, gate: "live-ratio", cfg: cfg(), tmp: dir, refCount: PEOPLE });
    assert.equal(res.ok, false);
    assert.ok(res.reason, "a failure must carry a reason a human can act on");
    // `ok === false` alone is NOT evidence: an unreachable database fails the same way, and this
    // test passed for exactly that wrong reason before the PGSSLROOTCERT fix above. Require the
    // reason to be about the DUMP, so infrastructure trouble can never masquerade as a caught defect.
    assert.doesNotMatch(
      res.reason ?? "",
      /could not reset|unreadable|could not read live/,
      `infrastructure failure, not a detected truncation: ${res.reason}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)`);
  }
});

test("verifyDumpFile runs the nonempty gate with NO live database configured", { skip }, async () => {
  // The manual drill (drill-object.ts) deliberately has no PG_LIVE_DATABASE_URL — that is the point
  // of its lean schema, so a routine drill never hands production credentials to a laptop. Its
  // default gate is `nonempty`, which consults no live table. An eager `pgConn(cfg.liveDatabaseUrl)`
  // at the top of verifyDumpFile made `new URL("")` throw and killed the drill in exactly this,
  // its documented, default invocation. Nothing caught it because every other test passes a real one.
  seedSource();
  const dir = mkdtempSync(join(tmpdir(), "gf-drill-test-"));
  try {
    const res = await verifyDumpFile({
      dumpPath: dumpSource(dir),
      gate: "nonempty",
      cfg: { ...cfg(), liveDatabaseUrl: "" },
      tmp: dir,
    });
    assert.equal(res.reason, null);
    assert.equal(res.ok, true);
    assert.equal(res.ratio, null, "the nonempty gate takes no ratio");
    assert.equal(res.counts.people, PEOPLE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)`);
  }
});

test("verifyDumpFile trips the ratio floor when the reference says rows are missing", { skip }, async () => {
  seedSource();
  const dir = mkdtempSync(join(tmpdir(), "gf-drill-test-"));
  try {
    const res = await verifyDumpFile({
      dumpPath: dumpSource(dir),
      gate: "live-ratio",
      cfg: cfg(),
      tmp: dir,
      refCount: PEOPLE * 10, // the dump should have had ~10× the rows it has
    });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /truncated or stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)`);
  }
});
