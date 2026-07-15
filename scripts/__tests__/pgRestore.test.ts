import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPgRestoreStderr } from "../lib/pgRestore.js";

// Fixtures use the MODERN pg_restore (PG12+) format the CI client actually emits — continuation lines
// prefixed `pg_restore: `, and the PG15+ `pg_restore: detail: Command was:` echo. The pre-PG12
// unprefixed format is kept as an explicit back-compat case (see the last test).

test("classify: tolerates modern managed-schema / vanilla-target noise", () => {
  const stderr = [
    `pg_restore: while PROCESSING TOC:`,
    `pg_restore: error: could not execute query: ERROR:  extension "pg_graphql" is not available`,
    `pg_restore: detail: Command was: CREATE EXTENSION IF NOT EXISTS pg_graphql WITH SCHEMA graphql;`,
    `pg_restore: error: could not execute query: ERROR:  role "supabase_admin" does not exist`,
    `pg_restore: detail: Command was: ALTER TABLE public.things OWNER TO supabase_admin;`,
    `pg_restore: error: could not execute query: ERROR:  schema "public" already exists`,
    `pg_restore: warning: errors ignored on restore: 3`,
  ].join("\n");
  const { benign, suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 0, `unexpected suspicious: ${suspicious.join(" | ")}`);
  assert.ok(benign.length >= 2, `expected benign lines, got ${benign.length}`);
});

test("classify: a MULTI-LINE Command-was echo (with error/enum words in its body) is context", () => {
  // The regression that failed liveone/boost: the SQL body of a failed CREATE echoes raw, and a
  // column named `error text` / an enum value `'ERROR'` must not read as an error line.
  const stderr = [
    `pg_restore: error: could not execute query: ERROR:  relation "audit_log" already exists`,
    `pg_restore: detail: Command was: CREATE TABLE public.audit_log (`,
    `    id integer NOT NULL,`,
    `    level public.log_level DEFAULT 'ERROR'::public.log_level,`,
    `    error text,`,
    `    note text`,
    `);`,
    `pg_restore: error: could not execute query: ERROR:  type "log_level" already exists`,
    `pg_restore: detail: Command was: CREATE TYPE public.log_level AS ENUM (`,
    `    'OK',`,
    `    'ERROR',`,
    `    'FATAL'`,
    `);`,
    `pg_restore: warning: errors ignored on restore: 2`,
  ].join("\n");
  const { suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 0, `unexpected suspicious: ${suspicious.join(" | ")}`);
});

test("classify: a real error is suspicious (modern), and its Command-was echo is not counted", () => {
  const stderr = [
    `pg_restore: while PROCESSING TOC:`,
    `pg_restore: error: could not execute query: ERROR:  invalid byte sequence for encoding "UTF8": 0xff`,
    `pg_restore: detail: Command was: COPY public.things (id, note) FROM stdin;`,
    `pg_restore: error: could not execute query: ERROR:  out of memory`,
  ].join("\n");
  const { suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 2, `got: ${suspicious.join(" | ")}`);
  assert.match(suspicious[0], /invalid byte sequence/);
  assert.match(suspicious[1], /out of memory/);
});

test("classify: restoring onto a NON-empty target (duplicate key / multiple PKs) stays suspicious", () => {
  // The pristine-target fix (restore-drill-pg.ts) prevents this at the source, but if it ever occurs
  // the classifier must still flag it — these are genuine restore failures, not managed-schema noise.
  const stderr = [
    `pg_restore: error: COPY failed for table "users": ERROR:  duplicate key value violates unique constraint "users_pkey"`,
    `pg_restore: error: could not execute query: ERROR:  multiple primary keys for table "users" are not allowed`,
  ].join("\n");
  const { suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 2, `got: ${suspicious.join(" | ")}`);
});

test("classify: mixed benign + suspicious are separated (modern)", () => {
  const stderr = [
    `pg_restore: error: could not execute query: ERROR:  role "x" does not exist`, // benign
    `pg_restore: detail: Command was: ALTER TABLE public.orders OWNER TO x;`, // context (echo)
    `pg_restore: error: could not execute query: ERROR:  relation "public.orders" does not exist`, // benign
    `pg_restore: error: could not execute query: ERROR:  out of memory`, // suspicious
  ].join("\n");
  const { benign, suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 1, `got: ${suspicious.join(" | ")}`);
  assert.match(suspicious[0], /out of memory/);
  assert.equal(benign.length, 2);
});

test("classify: back-compat with the pre-PG12 unprefixed format", () => {
  const stderr = [
    `pg_restore: while PROCESSING TOC:`,
    `pg_restore: error: could not execute query: ERROR:  role "app_admin" does not exist`,
    `    Command was: ALTER TABLE public.things OWNER TO app_admin;`, // bare/indented echo header
    `pg_restore: error: could not execute query: ERROR:  must be owner of extension plpgsql`,
    `pg_restore: error: could not execute query: ERROR:  schema "public" already exists`,
    `pg_restore: warning: errors ignored on restore: 3`,
  ].join("\n");
  const { benign, suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 0, `unexpected suspicious: ${suspicious.join(" | ")}`);
  assert.ok(benign.length >= 3);
});

test("classify: empty / clean stderr → nothing", () => {
  const r = classifyPgRestoreStderr("\n  \n");
  assert.deepEqual(r, { benign: [], suspicious: [] });
});
