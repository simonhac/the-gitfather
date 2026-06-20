import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTiers, runOrigin, stampToEpochMs } from "../lib/schedule.js";

test("runOrigin: schedule → schedule; dispatch/local → manual unless reason=self-heal", () => {
  assert.equal(runOrigin("schedule", undefined), "schedule");
  assert.equal(runOrigin("workflow_dispatch", undefined), "manual");
  assert.equal(runOrigin("workflow_dispatch", "self-heal"), "self-heal");
  assert.equal(runOrigin(undefined, undefined), "manual"); // local run
  assert.equal(runOrigin("", "self-heal"), "self-heal");
});

test("computeTiers: non-anchor hour → 2hourly only", () => {
  const d = new Date(Date.UTC(2026, 5, 19, 14, 0, 0)); // 14:00 UTC
  assert.deepEqual(computeTiers(d, 16, []), ["2hourly"]);
});

test("computeTiers: anchor hour on a weekday → +daily", () => {
  const d = new Date(Date.UTC(2026, 5, 19, 16, 0, 0)); // Fri 19 Jun 2026 16:00
  assert.notEqual(d.getUTCDay(), 0);
  assert.notEqual(d.getUTCDate(), 1);
  assert.deepEqual(computeTiers(d, 16, []), ["2hourly", "daily"]);
});

test("computeTiers: anchor hour on a Sunday → +weekly (bash %u=7 ↔ getUTCDay()=0)", () => {
  const d = new Date(Date.UTC(2026, 5, 21, 16, 0, 0)); // Sun 21 Jun 2026
  assert.equal(d.getUTCDay(), 0);
  assert.deepEqual(computeTiers(d, 16, []), ["2hourly", "daily", "weekly"]);
});

test("computeTiers: anchor hour on the 1st → +monthly", () => {
  const d = new Date(Date.UTC(2026, 6, 1, 16, 0, 0)); // Wed 1 Jul 2026
  assert.equal(d.getUTCDate(), 1);
  assert.notEqual(d.getUTCDay(), 0);
  assert.deepEqual(computeTiers(d, 16, []), ["2hourly", "daily", "monthly"]);
});

test("computeTiers: Sunday the 1st at anchor → daily + weekly + monthly", () => {
  const d = new Date(Date.UTC(2026, 1, 1, 16, 0, 0)); // 1 Feb 2026
  assert.equal(d.getUTCDate(), 1);
  assert.equal(d.getUTCDay(), 0); // Feb 1 2026 is a Sunday
  assert.deepEqual(computeTiers(d, 16, []), ["2hourly", "daily", "weekly", "monthly"]);
});

test("computeTiers: FORCE_TIERS overrides the computation", () => {
  const d = new Date(Date.UTC(2026, 5, 19, 14, 0, 0)); // non-anchor
  assert.deepEqual(computeTiers(d, 16, ["2hourly", "daily", "monthly"]), ["2hourly", "daily", "monthly"]);
});

test("stampToEpochMs: parses YYYYMMDDTHHMMSSZ as UTC; NaN on garbage", () => {
  assert.equal(stampToEpochMs("20260619T160000Z"), Date.UTC(2026, 5, 19, 16, 0, 0));
  assert.equal(stampToEpochMs("20260101T000000Z"), Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.ok(Number.isNaN(stampToEpochMs("not-a-real-stamp!")));
});
