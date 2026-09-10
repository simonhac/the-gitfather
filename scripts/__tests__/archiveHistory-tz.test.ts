import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicArchiveRun, PublicPayload } from "../lib/backupTypes.js";

// backupHistory.ts builds its Intl formatters from DISPLAY_TZ at MODULE LOAD (the bootEnv.ts
// contract), so the timezone has to be set before the first import — hence the dynamic import, and
// hence this living in its own file rather than in archiveHistory.test.ts (which imports statically
// and is therefore pinned to UTC). node:test runs each file in its own process, so this env write
// cannot leak into siblings.
process.env.DISPLAY_TZ = "Australia/Melbourne";
const { buildArchiveColumns, buildBackupGrid } = await import("../lib/backupHistory.js");

const NOW = new Date("2026-09-10T02:00:00Z"); // Thu 10 Sep, 12:00 pm AEST

const RETENTION = {
  "2hourly": { days: 2, label: "2 days" },
  daily: { days: 21, label: "3 weeks" },
  weekly: { days: 91, label: "13 weeks" },
  monthly: { days: 730, label: "2 years" },
} as const;

const archiveRun = (t: string): PublicArchiveRun => ({
  t, ok: true, table: "api_logs", mode: "both", dryRun: "none",
  weeksArchived: 1, rowsArchived: 100, weeksPruned: 1, rowsPruned: 100,
  bytes: 1, refusals: 0, anomalies: 0, runUrl: null,
});

const payload: PublicPayload = {
  label: "db",
  generatedAt: NOW.toISOString(),
  retention: RETENTION,
  // The Sunday 16:00 UTC anchor that gets promoted to the weekly tier.
  runs: [{ t: "2026-09-06T16:00:00Z", ok: true, tiers: ["2hourly", "daily", "weekly"], bytes: 1, runUrl: null }],
  verifications: [],
  // The archive task, 3.5 h later.
  archive: {
    tables: [{ table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 }],
    runs: [archiveRun("2026-09-06T19:30:00Z")],
  },
};

test("archive and weekly anchor share a row in Australia/Melbourne, where both cross into Monday", () => {
  // 16:00 UTC Sun 6 Sep = 2:00 am Mon 7 Sep AEST; 19:30 UTC = 5:30 am Mon 7 Sep AEST. Both land in
  // the CURRENT week here (row 0), where in UTC both land in the previous week (row 1) — the point
  // being that they move together. If the two grids ever placed timestamps differently, an archive
  // cell would drift a row away from the backup it followed by three and a half hours.
  const grid = buildBackupGrid(payload, NOW, 52);
  const cols = buildArchiveColumns(payload, NOW, 52)!;

  const backupRow = grid.rows.findIndex((r) => r.cells.size > 0);
  const archiveRow = cols.rows.findIndex((r) => r.size > 0);
  assert.equal(backupRow, 0, "the weekly anchor is in the current week under AEST");
  assert.equal(archiveRow, backupRow, "and the archive that followed it is on the same row");

  // Monday, first slot of the day — the wall clock really did roll over.
  const cell = [...grid.rows[0].cells.values()][0];
  assert.equal(cell.weekday, 0);
  assert.equal(cell.slot, 0);
  // Loose on the date punctuation, which is ICU's to choose; strict on the day, time and zone.
  assert.match(cols.rows[0].get("api_logs")!.runs[0].whenLabel, /^Mon\b.*\b7 Sep\w* 2026, 5:30 am AEST$/);
});
