import { test } from "node:test";
import assert from "node:assert/strict";
import { backupDue, backupLooksBroken, computeTiers, isBackupSlot, newestName, runOrigin, slotPhaseMinutes, slotState, stampToEpochMs } from "../lib/schedule.js";

test("runOrigin: schedule (cron OR reason=schedule) → schedule; dispatch/local → manual unless reason=self-heal", () => {
  assert.equal(runOrigin("schedule", undefined), "schedule"); // legacy GitHub cron
  assert.equal(runOrigin("workflow_dispatch", "schedule"), "schedule"); // Cloudflare automatic dispatch
  assert.equal(runOrigin("workflow_dispatch", undefined), "manual");
  assert.equal(runOrigin("workflow_dispatch", ""), "manual"); // manual UI run (reason input left blank)
  assert.equal(runOrigin("workflow_dispatch", "self-heal"), "self-heal");
  assert.equal(runOrigin(undefined, undefined), "manual"); // local run
  assert.equal(runOrigin("", "self-heal"), "self-heal");
});

test("computeTiers: non-anchor hour → intraday only", () => {
  const d = new Date(Date.UTC(2026, 5, 19, 14, 0, 0)); // 14:00 UTC
  assert.deepEqual(computeTiers(d, 16, []), ["intraday"]);
});

test("computeTiers: anchor hour on a weekday → +daily", () => {
  const d = new Date(Date.UTC(2026, 5, 19, 16, 0, 0)); // Fri 19 Jun 2026 16:00
  assert.notEqual(d.getUTCDay(), 0);
  assert.notEqual(d.getUTCDate(), 1);
  assert.deepEqual(computeTiers(d, 16, []), ["intraday", "daily"]);
});

test("computeTiers: anchor hour on a Sunday → +weekly (bash %u=7 ↔ getUTCDay()=0)", () => {
  const d = new Date(Date.UTC(2026, 5, 21, 16, 0, 0)); // Sun 21 Jun 2026
  assert.equal(d.getUTCDay(), 0);
  assert.deepEqual(computeTiers(d, 16, []), ["intraday", "daily", "weekly"]);
});

test("computeTiers: anchor hour on the 1st → +monthly", () => {
  const d = new Date(Date.UTC(2026, 6, 1, 16, 0, 0)); // Wed 1 Jul 2026
  assert.equal(d.getUTCDate(), 1);
  assert.notEqual(d.getUTCDay(), 0);
  assert.deepEqual(computeTiers(d, 16, []), ["intraday", "daily", "monthly"]);
});

test("computeTiers: Sunday the 1st at anchor → daily + weekly + monthly", () => {
  const d = new Date(Date.UTC(2026, 1, 1, 16, 0, 0)); // 1 Feb 2026
  assert.equal(d.getUTCDate(), 1);
  assert.equal(d.getUTCDay(), 0); // Feb 1 2026 is a Sunday
  assert.deepEqual(computeTiers(d, 16, []), ["intraday", "daily", "weekly", "monthly"]);
});

test("computeTiers: FORCE_TIERS overrides the computation", () => {
  const d = new Date(Date.UTC(2026, 5, 19, 14, 0, 0)); // non-anchor
  assert.deepEqual(computeTiers(d, 16, ["intraday", "daily", "monthly"]), ["intraday", "daily", "monthly"]);
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

const ok = { status: "completed", conclusion: "success" };
const bad = { status: "completed", conclusion: "failure" };
const timedOut = { status: "completed", conclusion: "timed_out" };
const running = { status: "in_progress", conclusion: null };
const queued = { status: "queued", conclusion: null };

test("backupLooksBroken: newest completed run succeeded → missed tick, retry-eligible", () => {
  assert.equal(backupLooksBroken([ok]), false);
  assert.equal(backupLooksBroken([ok, bad]), false);
});

test("backupLooksBroken: a single completed failure (success before it) → transient, still retry", () => {
  assert.equal(backupLooksBroken([bad, ok]), false);
});

test("backupLooksBroken: two consecutive completed failures → broken, do NOT retry", () => {
  assert.equal(backupLooksBroken([bad, timedOut, ok]), true);
});

test("backupLooksBroken: in-flight runs carry no verdict and are ignored", () => {
  // newest two are still running; completed history is one failure then success → not broken
  assert.equal(backupLooksBroken([running, queued, bad, ok]), false);
  // ...but two completed failures underneath in-flight runs still reads as broken
  assert.equal(backupLooksBroken([running, bad, bad]), true);
});

test("backupLooksBroken: fewer than two completed runs → benefit of the doubt (retry)", () => {
  assert.equal(backupLooksBroken([]), false);
  assert.equal(backupLooksBroken([bad]), false);
  assert.equal(backupLooksBroken([running]), false);
});

test("backupLooksBroken: a recent success between failures means it's recovering, not broken", () => {
  assert.equal(backupLooksBroken([bad, ok, bad]), false);
});

// ── backups-per-day: the dispatch grid, phased from the anchor hour ──────────────────────────

const hoursDue = (n: number, anchor: number): number[] =>
  Array.from({ length: 24 }, (_, h) => h).filter((h) => isBackupSlot(new Date(Date.UTC(2026, 5, 21, h, 0)), n, anchor));

test("isBackupSlot: n a day, phased from the anchor hour", () => {
  assert.deepEqual(hoursDue(3, 16), [0, 8, 16]); // today's schedule, unchanged
  assert.deepEqual(hoursDue(1, 16), [16]);
  assert.deepEqual(hoursDue(1, 0), [0]);
  assert.deepEqual(hoursDue(2, 5), [5, 17]);
  assert.deepEqual(hoursDue(3, 5), [5, 13, 21]);
  assert.equal(hoursDue(24, 16).length, 24);
  assert.ok(!isBackupSlot(new Date(Date.UTC(2026, 5, 21, 16, 10)), 1, 16), "on the hour only");
});

test("slotPhaseMinutes: the grid opens on the anchor hour", () => {
  assert.equal(slotPhaseMinutes(480, 16), 0);
  assert.equal(slotPhaseMinutes(1440, 16), 960);
  assert.equal(slotPhaseMinutes(720, 5), 300);
  assert.equal(slotPhaseMinutes(60, 16), 0);
});

test("slotState with a phase: once a day at 16:00 UTC", () => {
  const phase = slotPhaseMinutes(1440, 16);
  const yesterday1600 = H(16, 0) - 86_400_000;
  // 10:00 — still inside the slot that opened yesterday at 16:00, which has its backup.
  assert.equal(slotState(H(10, 0), yesterday1600, 1440, 25, phase).overdue, false);
  // 16:30 — today's slot is 30m old, past grace, and nothing new has landed.
  const late = slotState(H(16, 30), yesterday1600, 1440, 25, phase);
  assert.equal(late.overdue, true);
  assert.equal(new Date(late.slotStartMs).toISOString(), "2026-06-21T16:00:00.000Z");
  // Unphased, the same config would have called 00:30 overdue — the bug the phase prevents.
  assert.equal(slotState(H(0, 30), yesterday1600, 1440, 25, phase).overdue, false);
});

test("backupDue: any published schedule due → dispatch; nothing published → the default grid", () => {
  const t = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 21, h, m));
  const daily = { slotMinutes: 1440, anchorHourUtc: 16 };
  const threeADay = { slotMinutes: 480, anchorHourUtc: 16 };
  const hourly = { slotMinutes: 60, anchorHourUtc: 16 };
  assert.equal(backupDue(t(8), [daily]), false);
  assert.equal(backupDue(t(16), [daily]), true);
  assert.equal(backupDue(t(8), [threeADay]), true);
  assert.equal(backupDue(t(8), [daily, threeADay]), true, "one client, two databases — the union");
  assert.equal(backupDue(t(13), [hourly]), true);
  assert.equal(backupDue(t(13, 30), [hourly]), false);
  assert.equal(backupDue(t(0), []), true, "no config yet → 00/08/16");
  assert.equal(backupDue(t(4), []), false);
});

test("newestName: the lexical max across prefixes (same stamp format)", () => {
  const items = [
    { dir: "2hourly", name: "boost-20260920T160000Z.dump" },
    { dir: "intraday", name: "boost-20260921T000000Z.dump" },
    { dir: "2hourly", name: "boost-20260920T080000Z.dump" },
  ];
  assert.equal(newestName(items, (i) => i.name)?.dir, "intraday");
  assert.equal(newestName([], (i: { name: string }) => i.name), null);
});
