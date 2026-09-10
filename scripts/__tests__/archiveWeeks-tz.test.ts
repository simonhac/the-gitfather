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
const { isoWeekMondayOrdinal, dateOrdinal, currentWeekStartOrdinal, buildArchiveColumns } =
  await import("../lib/backupHistory.js");
const { DEFAULT_RETENTION } = await import("../lib/backupTypes.js");
type PublicPayload = import("../lib/backupTypes.js").PublicPayload;

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

test("a week's rows land on their own row end to end, not a Sunday earlier", () => {
  // The whole path, not just the arithmetic: 2026-W12 is the week of Mon 16 March. Bucketed as an
  // instant in a UTC-8 zone its Monday would fall on Sun 15 March — the previous row.
  const now = new Date("2026-03-26T02:00:00Z");
  const payload: PublicPayload = {
    label: "db",
    generatedAt: now.toISOString(),
    retention: DEFAULT_RETENTION,
    runs: [],
    verifications: [],
    archive: {
      tables: [{ table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 }],
      runs: [],
      weeks: [{ table: "api_logs", week: "2026-W12", state: "pruned", rows: 12 }],
    },
  };
  const cols = buildArchiveColumns(payload, now, 52)!;
  assert.deepEqual(cols.rows[1].get("api_logs")!.data, { state: "pruned", rows: 12 });
  assert.equal(cols.rows[2].size, 0, "not a row earlier");
});
