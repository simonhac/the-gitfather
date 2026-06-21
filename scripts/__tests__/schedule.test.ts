import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTiers, runOrigin, slotState, stampToEpochMs } from "../lib/schedule.js";

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

// 21 Jun 2026, given UTC h:m — slotState's "now" / "newest" inputs.
const H = (h: number, m = 0): number => Date.UTC(2026, 5, 21, h, m, 0);

test("slotState: this slot's backup landed → not overdue", () => {
  const s = slotState(H(4, 30), H(4, 5), 120, 25); // now 04:30, newest 04:05 (≥ 04:00 boundary)
  assert.equal(s.slotStartMs, H(4, 0));
  assert.equal(s.landed, true);
  assert.equal(s.overdue, false);
});

test("slotState: slot missing but still within grace → not overdue", () => {
  const s = slotState(H(4, 10), H(2, 50), 120, 25); // now 04:10 (< 04:25 due); newest from prior slot
  assert.equal(s.slotStartMs, H(4, 0));
  assert.equal(s.landed, false);
  assert.equal(s.overdue, false);
});

test("slotState: slot missing and past grace → overdue", () => {
  const s = slotState(H(4, 30), H(2, 50), 120, 25); // now 04:30 (≥ 04:25 due); 04:00 slot still empty
  assert.equal(s.dueMs, H(4, 25));
  assert.equal(s.landed, false);
  assert.equal(s.overdue, true);
});

test("slotState: 120-min slots align to even UTC hours (epoch-aligned)", () => {
  assert.equal(slotState(H(5, 59), H(4, 1), 120, 25).slotStartMs, H(4, 0)); // 05:59 → 04:00 slot
  assert.equal(slotState(H(6, 0), H(6, 0), 120, 25).slotStartMs, H(6, 0)); // 06:00 → 06:00 slot
  assert.equal(slotState(H(0, 5), H(0, 1), 120, 25).slotStartMs, H(0, 0)); // 00:05 → 00:00 slot
});

test("slotState: grace=0 → overdue the instant the boundary passes with nothing landed", () => {
  const s = slotState(H(4, 0) + 1, H(2, 50), 120, 0); // 1 ms past 04:00, no backup yet
  assert.equal(s.overdue, true);
});
