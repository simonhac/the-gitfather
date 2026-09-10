import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slotCadence,
  slotCadencePhrase,
  slotCadenceAdjective,
  slotsPerDayFrom,
  retentionBullets,
  DEFAULT_RETENTION,
  type RetentionMap,
} from "../lib/backupTypes.js";

// The dashboard blurb used to hardcode "a fresh one every 2 hours, 3 a day" — two claims that
// contradicted each other AND the actual cadence, because only the "3" was derived. These helpers
// exist so the prose can never drift from staleness.slot-minutes again.

test("slotsPerDayFrom: minutes per slot → slots per day", () => {
  assert.equal(slotsPerDayFrom(480), 3); // Boost today: 00:00 / 08:00 / 16:00 UTC
  assert.equal(slotsPerDayFrom(120), 12); // the engine's own default, and the old hardcoded prose
  assert.equal(slotsPerDayFrom(1440), 1);
  assert.equal(slotsPerDayFrom(60), 24);
});

test("slotCadencePhrase reads naturally at every supported cadence", () => {
  assert.equal(slotCadencePhrase(480), "a fresh one every 8 hours, 3 a day");
  assert.equal(slotCadencePhrase(120), "a fresh one every 2 hours, 12 a day");
  assert.equal(slotCadencePhrase(60), "a fresh one every hour, 24 a day");
  // One a day must not read "1 a day" — the count adds nothing once the interval IS a day.
  assert.equal(slotCadencePhrase(1440), "a fresh one once a day");
  // A sub-hour or non-integer-hour cadence falls back to minutes rather than "every 1.5 hours".
  assert.equal(slotCadencePhrase(90), "a fresh one every 90 minutes, 16 a day");
  assert.equal(slotCadencePhrase(30), "a fresh one every 30 minutes, 48 a day");
});

test("slotCadenceAdjective names the grandson tier without saying '2-hourly'", () => {
  assert.equal(slotCadenceAdjective(480), "8-hourly");
  assert.equal(slotCadenceAdjective(120), "2-hourly");
  assert.equal(slotCadenceAdjective(60), "hourly");
  assert.equal(slotCadenceAdjective(1440), "daily");
  assert.equal(slotCadenceAdjective(90), "90-minute");
});

test("bridgeSlotMinutes only accepts a slot width that tiles a day", async () => {
  const { bridgeSlotMinutes } = await import("../lib/profile.js");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "slot-"));

  const bridge = (yaml: string): string | undefined => {
    const f = join(dir, "p.yaml");
    writeFileSync(f, yaml);
    process.env.PROFILE = f;
    delete process.env.SLOT_MINUTES;
    bridgeSlotMinutes();
    return process.env.SLOT_MINUTES;
  };

  assert.equal(bridge("staleness:\n  slot-minutes: 480\n"), "480");
  assert.equal(bridge("staleness:\n  slot-minutes: 60\n"), "60");
  // Not a divisor of 1440 — left unset so the derived slot width stays coherent. The config layer
  // is what reports it; see requireValidStalenessSlot.
  assert.equal(bridge("staleness:\n  slot-minutes: 100\n"), undefined);
  assert.equal(bridge("staleness:\n  slot-minutes: 0\n"), undefined);
  // Absent staleness block, and a bare key (YAML null) — both leave the default alone.
  assert.equal(bridge("name: x\n"), undefined);
  assert.equal(bridge("staleness:\n"), undefined);

  delete process.env.PROFILE;
  delete process.env.SLOT_MINUTES;
});

// ── Header prose ─────────────────────────────────────────────────────────────
// The subtitle is a list, not a paragraph, so the pieces are built here and the DOM assembly in
// dashboard/heatmap.ts stays thin enough to read at a glance.

test("slotCadence splits into a lead and the part worth emphasising", () => {
  assert.deepEqual(slotCadence(480), { lead: "a fresh one every", emphasis: "8 hours, 3 a day" });
  assert.deepEqual(slotCadence(120), { lead: "a fresh one every", emphasis: "2 hours, 12 a day" });
  assert.deepEqual(slotCadence(90), { lead: "a fresh one every", emphasis: "90 minutes, 16 a day" });
  // "every once a day" would be nonsense, so the daily case moves the whole thing into the emphasis.
  assert.deepEqual(slotCadence(1440), { lead: "a fresh one", emphasis: "once a day" });
});

test("slotCadencePhrase is exactly its parts joined — the two cannot drift", () => {
  for (const m of [60, 120, 480, 720, 1440]) {
    const { lead, emphasis } = slotCadence(m);
    assert.equal(slotCadencePhrase(m), `${lead} ${emphasis}`);
  }
});

test("retentionBullets: one tier per bullet, connectives included, oldest last", () => {
  const R: RetentionMap = {
    ...DEFAULT_RETENTION,
    weekly: { days: 91, label: "13 weeks" },
    monthly: { days: 365, label: "12 months" },
  };
  assert.deepEqual(retentionBullets(R, 480), [
    "the 8-hourly “grandsons” are kept for 2 days, then",
    "one “son” per day for 3 weeks,",
    "one “father” per week for 13 weeks, and",
    "one “grandfather” per month for 12 months",
  ]);
  // The grandson bullet tracks the cadence, not the frozen `2hourly` key.
  assert.match(retentionBullets(R, 120)[0], /^the 2-hourly /);
  assert.match(retentionBullets(R, 1440)[0], /^the daily /);
  // Only the last bullet has no trailing connective — it is the one the "…at its fullest" line follows.
  assert.ok(!retentionBullets(R, 480)[3].endsWith(","));
});
