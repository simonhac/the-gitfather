import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLatestRun } from "../runlog.js";

const rec = (ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, ok: true, tiers: ["2hourly"], ...extra });

test("pickLatestRun: empty / absent bodies answer null, never throw", () => {
  for (const body of ["", "   ", "\n\n"]) assert.equal(pickLatestRun(body), null);
});

test("pickLatestRun: returns the newest record by ts, not by position", () => {
  // Read-modify-write means an out-of-order append is possible; ts is the authority.
  const body = [rec("2026-08-05T00:00:00Z"), rec("2026-08-05T08:00:00Z"), rec("2026-08-04T16:00:00Z")].join("\n");
  assert.equal(pickLatestRun(body)?.ts, "2026-08-05T08:00:00Z");
});

test("pickLatestRun: a torn final line does not discard the whole partition", () => {
  const body = `${rec("2026-08-04T16:00:00Z")}\n${rec("2026-08-05T00:00:00Z")}\n{"ts":"2026-08-05T08:0`;
  assert.equal(pickLatestRun(body)?.ts, "2026-08-05T00:00:00Z");
});

test("pickLatestRun: non-object and ts-less lines are skipped", () => {
  const body = ["null", "[]", "42", '{"ok":true}', rec("2026-08-05T00:00:00Z")].join("\n");
  assert.equal(pickLatestRun(body)?.ts, "2026-08-05T00:00:00Z");
});

test("pickLatestRun: surfaces the classified cause the watchdog quotes", () => {
  const body = rec("2026-08-05T00:01:00Z", {
    ok: false,
    tiers: [],
    error: "credential rejected by the database — PG_BACKUP_DATABASE_URL is stale",
    errorCode: "auth-rejected",
  });
  const latest = pickLatestRun(body);
  assert.equal(latest?.ok, false);
  assert.equal(latest?.errorCode, "auth-rejected");
  assert.match(String(latest?.error), /PG_BACKUP_DATABASE_URL/);
});

test("pickLatestRun: a legacy record with no errorCode reads as null, not undefined-crash", () => {
  const latest = pickLatestRun(rec("2026-07-01T00:00:00Z", { ok: false, tiers: [], error: "pg_dump failed" }));
  assert.equal(latest?.errorCode ?? null, null);
});
