import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedDurableKeys } from "../lib/durableCensus.js";
import { DEFAULT_RETENTION, type LogRun, type RetentionMap } from "../lib/backupTypes.js";

const NOW = Date.parse("2026-09-10T00:00:00Z");
const DAY = 86_400_000;

// Boost's live windows (the profile overrides the engine defaults for monthly).
const RETENTION: RetentionMap = {
  ...DEFAULT_RETENTION,
  monthly: { days: 365, label: "12 months" },
};

const run = (o: Partial<LogRun> & { ts: string; tiers: LogRun["tiers"] }): LogRun => ({
  ok: true,
  bytes: 1,
  key: `2hourly/boost-${o.ts.replace(/[-:]/g, "")}.dump`,
  sha256: null,
  counts: null,
  runId: null,
  runUrl: null,
  error: null,
  errorCode: null,
  durationMs: null,
  ...o,
});

test("expectedDurableKeys: a promotion inside its window is expected, in EVERY durable tier", () => {
  const runs = [run({ ts: "2026-09-06T16:00:51Z", tiers: ["2hourly", "daily", "weekly"] })];
  assert.deepEqual(expectedDurableKeys(runs, RETENTION, NOW), [
    "daily/boost-20260906T160051Z.dump",
    "weekly/boost-20260906T160051Z.dump",
  ]);
});

test("expectedDurableKeys: 2hourly is never expected — it is not a durable tier", () => {
  const runs = [run({ ts: "2026-09-09T08:01:15Z", tiers: ["2hourly"] })];
  assert.deepEqual(expectedDurableKeys(runs, RETENTION, NOW), []);
});

test("expectedDurableKeys: past its window, and inside the grace band, it is NOT expected", () => {
  const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const at = (days: number): LogRun =>
    run({ ts: iso(NOW - days * DAY), tiers: ["2hourly", "daily"] });

  // daily = 21 days. Well inside → expected.
  assert.equal(expectedDurableKeys([at(19)], RETENTION, NOW).length, 1);
  // Within the last graceDays of the window → NOT expected: R2 lifecycle expiry is asynchronous,
  // so an object at the very edge may legitimately have just been swept. A floor, not a census.
  assert.equal(expectedDurableKeys([at(20.5)], RETENTION, NOW).length, 0);
  // Past the window → NOT expected.
  assert.equal(expectedDurableKeys([at(30)], RETENTION, NOW).length, 0);
});

test("expectedDurableKeys: a FAILED run promises nothing, and a keyless record is skipped", () => {
  const failed = run({ ts: "2026-09-09T16:01:23Z", tiers: [], ok: false });
  const keyless = run({ ts: "2026-09-08T16:01:22Z", tiers: ["2hourly", "daily"], key: null });
  assert.deepEqual(expectedDurableKeys([failed, keyless], RETENTION, NOW), []);
});

test("expectedDurableKeys: BOTH generations are expected across an encryption switch", () => {
  // The census that would have caught the 34 → 1 collapse: the run-log holds plaintext and
  // encrypted promotions side by side, and every one of them is still owed to R2.
  const runs = [
    run({ ts: "2026-09-08T16:01:22Z", tiers: ["2hourly", "daily"] }),
    run({
      ts: "2026-09-09T16:01:23Z",
      tiers: ["2hourly", "daily"],
      key: "2hourly/boost-20260909T160123Z.dump.age",
    }),
  ];
  assert.deepEqual(expectedDurableKeys(runs, RETENTION, NOW), [
    "daily/boost-20260908T160122Z.dump",
    "daily/boost-20260909T160123Z.dump.age",
  ]);
});

test("expectedDurableKeys: duplicates collapse and the result is stable-sorted", () => {
  const r = run({ ts: "2026-09-09T16:01:23Z", tiers: ["daily", "daily", "monthly"] });
  assert.deepEqual(expectedDurableKeys([r, r], RETENTION, NOW), [
    "daily/boost-20260909T160123Z.dump",
    "monthly/boost-20260909T160123Z.dump",
  ]);
});
