import { test } from "node:test";
import assert from "node:assert/strict";
import { isoWeekMondayOrdinal, dateOrdinal, weekdayMon0 } from "../lib/backupHistory.js";
import { isoWeek, isoWeekOf, weeksInIsoYear, WEEK_MS } from "../lib/archive.js";

// An archive week's BODY is placed by its ISO label, not by a run timestamp — so this mapping is
// what decides which row a week's rows appear on. It is duplicated arithmetic (lib/archive.ts owns
// the writer's copy, and imports node:crypto, so it can never join the browser bundle); these tests
// are what stop the two copies drifting.

test("isoWeekMondayOrdinal: the label lands on its own Monday", () => {
  // 2026-W13 is the week of Mon 23 March 2026.
  assert.equal(isoWeekMondayOrdinal("2026-W13"), dateOrdinal(2026, 3, 23));
  assert.equal(weekdayMon0(isoWeekMondayOrdinal("2026-W13")), 0);
});

test("isoWeekMondayOrdinal: W01 can start in the PREVIOUS calendar year", () => {
  // 2026-W01 is the week containing 4 Jan 2026 (a Sunday), so it starts Mon 29 Dec 2025.
  assert.equal(isoWeekMondayOrdinal("2026-W01"), dateOrdinal(2025, 12, 29));
  // …and 2027-W01 starts Mon 4 Jan 2027, because 4 January IS the Monday that year.
  assert.equal(isoWeekMondayOrdinal("2027-W01"), dateOrdinal(2027, 1, 4));
});

test("isoWeekMondayOrdinal: W53 exists in a 53-week year and not otherwise", () => {
  assert.equal(weeksInIsoYear(2026), 53);
  assert.equal(isoWeekMondayOrdinal("2026-W53"), dateOrdinal(2026, 12, 28));
  assert.equal(weeksInIsoYear(2025), 52);
  assert.throws(() => isoWeekMondayOrdinal("2025-W53"), /53 ISO weeks|52 ISO weeks/);
});

test("isoWeekMondayOrdinal: a malformed or impossible label throws rather than clamping", () => {
  // Clamping would put a week's rows on a row they do not belong to, silently.
  for (const bad of ["2026-W00", "2026-W54", "2026-W99", "2026W13", "26-W13", "2026-w13", ""]) {
    assert.throws(() => isoWeekMondayOrdinal(bad), new RegExp("invalid ISO week label"), bad);
  }
});

test("isoWeekMondayOrdinal agrees with lib/archive.ts over 400 consecutive weeks", () => {
  // The writer's arithmetic and the dashboard's, walked side by side across three year boundaries
  // (including 2026's 53rd week) — the pin that keeps the duplication honest.
  let w = isoWeekOf(new Date(Date.UTC(2024, 5, 3)));
  for (let i = 0; i < 400; i++) {
    assert.equal(
      isoWeekMondayOrdinal(w.label),
      Math.floor(w.start.getTime() / 86_400_000),
      `${w.label} must sit on ${w.start.toISOString().slice(0, 10)}`,
    );
    w = isoWeekOf(new Date(w.start.getTime() + WEEK_MS));
  }
});

test("isoWeekMondayOrdinal: every week of a 53-week year round-trips", () => {
  for (let n = 1; n <= weeksInIsoYear(2026); n++) {
    const label = `2026-W${String(n).padStart(2, "0")}`;
    assert.equal(isoWeekMondayOrdinal(label), Math.floor(isoWeek(2026, n).start.getTime() / 86_400_000), label);
  }
});
