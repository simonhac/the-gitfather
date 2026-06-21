import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPgRestoreStderr } from "../lib/pgRestore.js";

test("classify: tolerates managed-schema / vanilla-target noise", () => {
  const stderr = [
    `pg_restore: while PROCESSING TOC:`,
    `pg_restore: error: could not execute query: ERROR:  role "app_admin" does not exist`,
    `    Command was: ALTER TABLE public.things OWNER TO app_admin;`,
    `pg_restore: error: could not execute query: ERROR:  must be owner of extension plpgsql`,
    `pg_restore: error: could not execute query: ERROR:  schema "public" already exists`,
    `pg_restore: warning: errors ignored on restore: 3`,
  ].join("\n");
  const { benign, suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 0, `unexpected suspicious: ${suspicious.join(" | ")}`);
  assert.ok(benign.length >= 3);
});

test("classify: a real error is suspicious", () => {
  const stderr = [
    `pg_restore: while PROCESSING TOC:`,
    `pg_restore: error: could not execute query: ERROR:  invalid byte sequence for encoding "UTF8": 0xff`,
  ].join("\n");
  const { suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 1);
  assert.match(suspicious[0], /invalid byte sequence/);
});

test("classify: mixed benign + suspicious are separated", () => {
  const stderr = [
    `pg_restore: error: could not execute query: ERROR:  role "x" does not exist`, // benign
    `pg_restore: error: could not execute query: ERROR:  relation "public.orders" does not exist`, // benign (does not exist)
    `pg_restore: error: could not execute query: ERROR:  out of memory`, // suspicious
  ].join("\n");
  const { benign, suspicious } = classifyPgRestoreStderr(stderr);
  assert.equal(suspicious.length, 1);
  assert.match(suspicious[0], /out of memory/);
  assert.equal(benign.length, 2);
});

test("classify: empty / clean stderr → nothing", () => {
  const r = classifyPgRestoreStderr("\n  \n");
  assert.deepEqual(r, { benign: [], suspicious: [] });
});
