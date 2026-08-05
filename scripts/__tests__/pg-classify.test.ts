import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPgFailure, redactPgStderr } from "../lib/pg-classify.js";

// The verbatim stderr from boost-suite/boost run 30961870918 (2026-08-05T00:01:02Z) — the
// failure this module was written for. Sixteen hours of @here pages said only "pg_dump failed".
const BOOST_AUTH_STDERR = `pg_dump: error: connection to server at "aws-1-eu-west-1.pooler.supabase.com" (54.229.189.117), port 5432 failed: FATAL:  password authentication failed for user "postgres"
password retrieved from file "/tmp/pg-backup-ZZM2O0/.pgpass-3519-0"
`;

test("classify: the real rotated-password failure is auth-rejected, non-transient, and names the secret", () => {
  const f = classifyPgFailure(BOOST_AUTH_STDERR);
  assert.equal(f.code, "auth-rejected");
  assert.equal(f.transient, false);
  assert.match(f.message, /PG_BACKUP_DATABASE_URL/);
  // The whole point: the operator can act on the Slack text without opening the Actions log.
  assert.match(f.message, /credential rejected/i);
});

test("classify: a matched failure never echoes the pgpass path or a stderr tail", () => {
  const f = classifyPgFailure(BOOST_AUTH_STDERR);
  assert.doesNotMatch(f.message, /\.pgpass/);
  assert.doesNotMatch(f.message, /pg-backup-ZZM2O0/);
});

test("classify: Supavisor's tenant rejection is distinct from a bad password", () => {
  const f = classifyPgFailure(`pg_dump: error: connection to server failed: FATAL:  Tenant or user not found`);
  assert.equal(f.code, "pooler-tenant");
  assert.equal(f.transient, false);
  assert.match(f.message, /postgres\.<project_ref>/);
});

test("classify: a stale client major is client-version, not an auth problem", () => {
  const f = classifyPgFailure(
    `pg_dump: error: server version: 17.6; pg_dump version: 15.4\npg_dump: error: aborting because of server version mismatch`,
  );
  assert.equal(f.code, "client-version");
  assert.equal(f.transient, false);
  assert.match(f.message, /client-major/);
});

test("classify: an unresolvable host is dns", () => {
  const f = classifyPgFailure(
    `pg_dump: error: could not translate host name "db.abc.supabase.co" to address: nodename nor servname provided`,
  );
  assert.equal(f.code, "dns");
  assert.equal(f.transient, false);
});

test("classify: the genuinely transient network classes are marked transient", () => {
  for (const stderr of [
    `pg_dump: error: connection to server failed: SSL connection has been closed unexpectedly`,
    `pg_dump: error: could not receive data from server: Connection reset by peer`,
    `Error: read ECONNRESET`,
  ]) {
    const f = classifyPgFailure(stderr);
    assert.equal(f.code, "connection-reset", stderr);
    assert.equal(f.transient, true, stderr);
  }
});

test("classify: connection-limit and statement-timeout are transient; privileges is not", () => {
  assert.deepEqual(
    (({ code, transient }) => ({ code, transient }))(classifyPgFailure(`FATAL:  sorry, too many clients already`)),
    { code: "saturated", transient: true },
  );
  assert.deepEqual(
    (({ code, transient }) => ({ code, transient }))(
      classifyPgFailure(`FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute`),
    ),
    { code: "saturated", transient: true },
  );
  assert.deepEqual(
    (({ code, transient }) => ({ code, transient }))(
      classifyPgFailure(`pg_dump: error: canceling statement due to statement timeout`),
    ),
    { code: "timeout", transient: true },
  );
  assert.deepEqual(
    (({ code, transient }) => ({ code, transient }))(
      classifyPgFailure(`pg_dump: error: query failed: ERROR:  permission denied for table people`),
    ),
    { code: "privileges", transient: false },
  );
});

test("classify: a full runner disk is transient (the next runner is fresh)", () => {
  const f = classifyPgFailure(`pg_dump: error: could not write to output file: No space left on device`);
  assert.equal(f.code, "runner-disk");
  assert.equal(f.transient, true);
});

// ── The unmatched arm: stays loud and generic, but must remain diagnosable ────

test("classify: an unmatched failure keeps the generic label AND carries a stderr tail", () => {
  const f = classifyPgFailure(`pg_dump: error: something nobody has documented went wrong`);
  assert.equal(f.code, "unknown");
  assert.equal(f.transient, false); // never guess a verdict — an unknown failure is not retryable
  assert.match(f.message, /pg_dump failed/);
  assert.match(f.message, /nobody has documented/);
});

test("classify: the unmatched tail is redacted — no pgpass path, no URL credential", () => {
  const f = classifyPgFailure(
    `pg_dump: error: undocumented explosion while connecting to ` +
      `postgres://postgres.rsfxqxoaxmtqrjnxpofm:sup3r-s3cret@aws-1-eu-west-1.pooler.supabase.com:5432/postgres\n` +
      `password retrieved from file "/tmp/pg-backup-ZZM2O0/.pgpass-3519-0"\n`,
  );
  assert.equal(f.code, "unknown");
  assert.doesNotMatch(f.message, /sup3r-s3cret/);
  assert.doesNotMatch(f.message, /pg-backup-ZZM2O0/);
  assert.match(f.message, /\*\*\*/); // the credential was masked, not silently dropped
});

test("classify: an empty stderr degrades to the bare label, not an empty message", () => {
  assert.equal(classifyPgFailure("").message, "pg_dump failed");
  assert.equal(classifyPgFailure("   \n\n  ").message, "pg_dump failed");
  assert.equal(classifyPgFailure("", "pg_dump | age pipeline failed").message, "pg_dump | age pipeline failed");
});

test("classify: the tail is bounded, so a screaming child can't flood Slack", () => {
  const noisy = Array.from({ length: 500 }, (_, i) => `line ${i} of undocumented noise`).join("\n");
  const f = classifyPgFailure(noisy);
  assert.equal(f.code, "unknown");
  assert.ok(f.message.length < 500, `message was ${f.message.length} chars`);
});

test("classify: rules are stateless — the same input classifies identically every time", () => {
  // A `g`-flagged rule regex would carry lastIndex between calls and misfire on the 2nd.
  for (let i = 0; i < 3; i++) assert.equal(classifyPgFailure(BOOST_AUTH_STDERR).code, "auth-rejected");
});

// ── Redaction, tested directly ───────────────────────────────────────────────

test("redact: masks URL credentials, pgpass paths, and keyword/value passwords", () => {
  const out = redactPgStderr(
    `connecting to postgres://postgres.ref:hunter2@host:5432/postgres\n` +
      `password retrieved from file "/tmp/x/.pgpass-1-0"\n` +
      `conninfo: host=h user=u password=hunter2 sslmode=require\n` +
      `PGPASSWORD=hunter2 psql\n`,
  );
  assert.doesNotMatch(out, /hunter2/);
  assert.doesNotMatch(out, /\.pgpass-1-0/);
  assert.match(out, /postgres:\/\/postgres\.ref:\*\*\*@host/); // structure preserved, secret gone
});

test("redact: leaves an innocent line untouched", () => {
  const line = `pg_dump: error: connection to server at "host" (1.2.3.4), port 5432 failed`;
  assert.equal(redactPgStderr(line), line);
});
