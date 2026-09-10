import { test } from "node:test";
import assert from "node:assert/strict";

// backupHistory.ts builds its Intl formatters from DISPLAY_TZ at MODULE LOAD (the bootEnv.ts
// contract), so the timezone has to be set before the first import — hence the dynamic import, and
// hence a file of its own. node:test gives each file its own process, so this env write cannot leak.
//
// The pin: an ISO week sits on its Monday's row in a NEGATIVE-offset zone. Treating the label's
// Monday 00:00 UTC as an instant and bucketing it in DISPLAY_TZ would land on the previous Sunday
// and shift every archive body up a row — a whole-column error that looks like plausible data.
process.env.DISPLAY_TZ = "America/Los_Angeles";
const { isoWeekMondayOrdinal, dateOrdinal, currentWeekStartOrdinal } = await import("../lib/backupHistory.js");

test("an ISO week label is a calendar fact, not an instant, even 8 hours behind UTC", () => {
  assert.equal(isoWeekMondayOrdinal("2026-W13"), dateOrdinal(2026, 3, 23));
});

test("and it lands on the row the grid measures back from", () => {
  // Thu 26 Mar 2026, 02:00 UTC — still Wed 25 Mar in Los Angeles, the same ISO week either way.
  const currentWeekStart = currentWeekStartOrdinal(new Date("2026-03-26T02:00:00Z"));
  const row = (label: string): number => (currentWeekStart - isoWeekMondayOrdinal(label)) / 7;
  assert.equal(row("2026-W13"), 0, "this week");
  assert.equal(row("2026-W12"), 1, "the week above it");
  assert.equal(row("2026-W01"), 12);
});
