import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveArchiveState, buildArchiveColumns, summarizeArchives, archiveStoredBytes } from "../lib/backupHistory.js";
import { archiveBlurb } from "../lib/backupTypes.js";
import type { PublicArchiveRun, PublicArchiveTable, PublicArchiveWeek, PublicPayload } from "../lib/backupTypes.js";

// This file runs in the default DISPLAY_TZ (UTC) — backupHistory.ts captures it at module load.
// The non-UTC alignment case lives in archiveHistory-tz.test.ts for that reason.

const run = (over: Partial<PublicArchiveRun> = {}): PublicArchiveRun => ({
  t: "2026-09-06T19:30:00Z",
  ok: true,
  table: "api_logs",
  mode: "both",
  dryRun: "none",
  weeksArchived: 1,
  rowsArchived: 48_213,
  weeksPruned: 1,
  rowsPruned: 51_004,
  bytes: 3_100_000,
  refusals: 0,
  anomalies: 0,
  runUrl: null,
  ...over,
});

// ── deriveArchiveState ───────────────────────────────────────────────────────

test("deriveArchiveState: a run that moved work is 'archived'", () => {
  assert.equal(deriveArchiveState(run()), "archived");
});

test("deriveArchiveState: ok but nothing eligible is 'quiet', not 'archived'", () => {
  assert.equal(deriveArchiveState(run({ weeksArchived: 0, weeksPruned: 0 })), "quiet");
});

test("deriveArchiveState: a dry run is 'quiet' even though it reports work", () => {
  // The counts are what it WOULD have done; the database did not change, so the cell must not
  // claim it did.
  assert.equal(deriveArchiveState(run({ dryRun: "source" })), "quiet");
});

test("deriveArchiveState: refusals and anomalies are 'attention'", () => {
  assert.equal(deriveArchiveState(run({ refusals: 2 })), "attention");
  assert.equal(deriveArchiveState(run({ anomalies: 1 })), "attention");
});

test("deriveArchiveState: a plain failure is 'failed'", () => {
  assert.equal(deriveArchiveState(run({ ok: false, weeksArchived: 0, weeksPruned: 0 })), "failed");
});

test("deriveArchiveState: a REFUSAL arrives as ok:false and must still be amber, not red", () => {
  // archive-table.ts writes `ok: !failure && refusals.length === 0 && anomalies.length === 0`, so
  // every refusal is also a not-ok record. Testing `!ok` first would paint "the gate declined to
  // delete, on purpose" in the same red as "the job broke".
  assert.equal(deriveArchiveState(run({ ok: false, refusals: 2 })), "attention");
  assert.equal(deriveArchiveState(run({ ok: false, anomalies: 3 })), "attention");
});

// ── buildArchiveColumns ──────────────────────────────────────────────────────

const NOW = new Date("2026-09-10T02:00:00Z");

const payloadWith = (
  runs: PublicArchiveRun[],
  tables: PublicArchiveTable[] = [{ table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 }],
  weeks?: PublicArchiveWeek[],
): PublicPayload => ({
  label: "db",
  generatedAt: NOW.toISOString(),
  retention: {
    "2hourly": { days: 2, label: "2 days" },
    daily: { days: 21, label: "3 weeks" },
    weekly: { days: 91, label: "13 weeks" },
    monthly: { days: 730, label: "2 years" },
  },
  runs: [],
  verifications: [],
  archive: weeks ? { tables, runs, weeks } : { tables, runs },
});

test("buildArchiveColumns: null when the profile archives nothing", () => {
  const bare = payloadWith([]);
  delete bare.archive;
  assert.equal(buildArchiveColumns(bare, NOW), null);
  assert.equal(buildArchiveColumns(payloadWith([], []), NOW), null);
});

test("buildArchiveColumns: the Sunday 19:30 archive shares a row with the 16:00 weekly anchor", () => {
  // This is the whole premise of putting the columns beside the grid: the archive runs 3.5 h after
  // the anchor that becomes the weekly backup, so both must land in the same week row.
  const cols = buildArchiveColumns(payloadWith([run({ t: "2026-09-06T19:30:00Z" })]), NOW)!;
  const anchorRow = 1; // 6 Sep 2026 is a Sunday, in the week starting Mon 31 Aug; now is Thu 10 Sep
  assert.equal(cols.rows[anchorRow].get("api_logs")?.runs.length, 1);
  assert.equal(cols.rows[0].size, 0, "the current week has no archive run yet");

  // ...and the backup that anchors it resolves to the same row through the same helper.
  const backup = payloadWith([]);
  backup.runs = [{ t: "2026-09-06T16:00:00Z", ok: true, tiers: ["weekly"], bytes: 1, runUrl: null }];
  assert.equal(buildArchiveColumns(payloadWith([run({ t: "2026-09-06T16:00:00Z" })]), NOW)!.rows[anchorRow].size, 1);
});

test("buildArchiveColumns: a run outside the window is dropped, not clamped to a row", () => {
  const cols = buildArchiveColumns(payloadWith([run({ t: "2024-01-07T19:30:00Z" })]), NOW, 52)!;
  assert.equal(cols.rows.reduce((n, r) => n + r.size, 0), 0);
});

test("buildArchiveColumns: a table seen only in the log still gets a column", () => {
  // A table dropped from `archive.tables` keeps its history visible — the rows it moved are still
  // out there. build-dashboard unions it into `tables`; this pins the consumer side.
  const cols = buildArchiveColumns(
    payloadWith([run({ table: "audit_events" })], [
      { table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 },
      { table: "audit_events", archiveAfterWeeks: null, pruneAfterWeeks: null },
    ]),
    NOW,
  )!;
  assert.deepEqual(cols.tables, ["api_logs", "audit_events"]);
  assert.equal(cols.rows[1].get("audit_events")?.runs.length, 1);
});

test("buildArchiveColumns: two runs in one week land in one cell, and the mark keeps both", () => {
  const cols = buildArchiveColumns(
    payloadWith([
      run({ t: "2026-09-06T19:30:00Z" }),
      run({ t: "2026-09-06T22:30:00Z", ok: false, refusals: 1, weeksArchived: 0, weeksPruned: 0 }),
    ]),
    NOW,
  )!;
  const cell = cols.rows[1].get("api_logs")!;
  assert.deepEqual(cell.mark, { worst: "attention", second: "ok", codes: 2 }, "two dashes");
  assert.equal(cell.data, null, "no index was read, so the week holds no body");
  assert.deepEqual(cell.runs.map((r) => r.run.t), ["2026-09-06T19:30:00Z", "2026-09-06T22:30:00Z"], "time-sorted");
});

test("buildArchiveColumns: a failure outranks a refusal in the mark", () => {
  const cols = buildArchiveColumns(
    payloadWith([
      run({ t: "2026-09-06T19:30:00Z", ok: false, refusals: 1 }),
      run({ t: "2026-09-06T20:30:00Z", ok: false, weeksArchived: 0, weeksPruned: 0 }),
    ]),
    NOW,
  )!;
  assert.deepEqual(cols.rows[1].get("api_logs")!.mark, { worst: "failed", second: "attention", codes: 2 });
});

// ── The data channel (_index/) ───────────────────────────────────────────────
// The body is about the rows DATED a week; the mark is about the runs that happened in it. These
// are different weeks, and the tests are written to keep them apart.

const week = (over: Partial<PublicArchiveWeek> = {}): PublicArchiveWeek => ({
  table: "api_logs", week: "2026-W36", state: "archived", rows: 1_671, ...over,
});

test("buildArchiveColumns: a week's rows land on the row of the week they are DATED", () => {
  // 2026-W36 is the week of Mon 31 Aug 2026 — row 1 with now = Thu 10 Sep.
  const cols = buildArchiveColumns(payloadWith([], undefined, [week()]), NOW)!;
  assert.deepEqual(cols.rows[1].get("api_logs")!.data, { state: "archived", rows: 1_671 });
  assert.equal(cols.rows[0].size, 0);
  assert.equal(cols.rows[2].size, 0);
});

test("buildArchiveColumns: a cell can be data with NO run — that is the normal case", () => {
  // The run that archives a week happens weeks later, so most bodies have no run beneath them.
  const cols = buildArchiveColumns(payloadWith([], undefined, [week({ week: "2026-W20", state: "pruned", rows: 9 })]), NOW)!;
  const cell = [...cols.rows.flatMap((r) => [...r.values()])][0];
  assert.deepEqual(cell.data, { state: "pruned", rows: 9 });
  assert.deepEqual(cell.runs, []);
  assert.deepEqual(cell.mark, { worst: null, second: null, codes: 0 }, "nothing ran — nothing to mark");
});

test("buildArchiveColumns: a pruned body and a refusing run coexist in one cell", () => {
  // Two correct views of two different subjects: those rows ARE pruned, and this week's run
  // declined to delete some other week's. Neither overrides the other.
  const cols = buildArchiveColumns(
    payloadWith(
      [run({ t: "2026-09-06T19:30:00Z", ok: false, refusals: 2, weeksArchived: 0, weeksPruned: 0 })],
      undefined,
      [week({ state: "pruned" })],
    ),
    NOW,
  )!;
  const cell = cols.rows[1].get("api_logs")!;
  assert.deepEqual(cell.data, { state: "pruned", rows: 1_671 });
  assert.deepEqual(cell.mark, { worst: "attention", second: null, codes: 1 });
});

test("buildArchiveColumns: weeks outside the window, of unknown tables, or impossible are dropped", () => {
  const cols = buildArchiveColumns(
    payloadWith([], undefined, [
      week({ week: "2024-W36" }),          // before the window
      week({ week: "2027-W01" }),          // after it
      week({ table: "ghost_table" }),      // no such column
      week({ week: "2025-W53" }),          // well-formed, but 2025 has no 53rd week
      week({ week: "not-a-week" }),
    ]),
    NOW,
  )!;
  assert.equal(cols.rows.reduce((n, r) => n + r.size, 0), 0, "one bad label must not cost the block");
});

test("buildArchiveColumns: an absent index means no bodies, and is not the same as an empty one", () => {
  // `weeks` absent = we did not read the index this build; [] = we read it and it was empty. Both
  // draw nothing, but only the second is knowledge — the distinction lives in the payload.
  const absent = payloadWith([run()]);
  const empty = payloadWith([run()], undefined, []);
  assert.equal(absent.archive!.weeks, undefined);
  assert.deepEqual(empty.archive!.weeks, []);
  for (const p of [absent, empty]) {
    assert.equal(buildArchiveColumns(p, NOW)!.rows[1].get("api_logs")!.data, null);
  }
});

// ── summaries ────────────────────────────────────────────────────────────────

test("summarizeArchives: counts rows for real runs only, and every troubled run as an issue", () => {
  const stats = summarizeArchives(
    buildArchiveColumns(
      payloadWith([
        run({ t: "2026-09-06T19:30:00Z", rowsArchived: 100, rowsPruned: 10 }),
        run({ t: "2026-08-30T19:30:00Z", dryRun: "source", rowsArchived: 999, rowsPruned: 999 }),
        run({ t: "2026-08-23T19:30:00Z", ok: false, refusals: 1, rowsArchived: 50, rowsPruned: 0 }),
        run({ t: "2026-08-16T19:30:00Z", ok: false, weeksArchived: 0, weeksPruned: 0, rowsArchived: 0, rowsPruned: 0 }),
      ]),
      NOW,
    )!,
  );
  assert.deepEqual(stats, { rowsArchived: 150, rowsPruned: 10, issues: 2, weeksArchived: 0, weeksPruned: 0 });
});

test("summarizeArchives: counts table-weeks from the DATA channel, not from the runs", () => {
  const stats = summarizeArchives(
    buildArchiveColumns(
      payloadWith([], undefined, [
        week({ week: "2026-W36", state: "pruned" }),
        week({ week: "2026-W35", state: "archived" }),
        week({ week: "2026-W34", state: "pruned" }),
        week({ week: "2019-W02", state: "pruned" }), // outside the visible window
      ]),
      NOW,
    )!,
  );
  assert.equal(stats.weeksArchived, 3, "every week whose rows are in the archive");
  assert.equal(stats.weeksPruned, 2, "of which these are also gone from the database");
  assert.equal(stats.rowsArchived, 0, "rows are a RUN figure — no runs here moved any");
});

test("archiveStoredBytes: cumulative over real successful runs; nothing here expires", () => {
  const payload = payloadWith([
    run({ t: "2026-09-06T19:30:00Z", bytes: 1000 }),
    run({ t: "2020-01-05T19:30:00Z", bytes: 2000 }), // long outside the grid, still on the bill
    run({ t: "2026-08-30T19:30:00Z", bytes: 4000, dryRun: "store" }), // never reached the bucket
    run({ t: "2026-08-23T19:30:00Z", bytes: 8000, ok: false }),
  ]);
  assert.equal(archiveStoredBytes(payload), 3000);
  const bare = payloadWith([]);
  delete bare.archive;
  assert.equal(archiveStoredBytes(bare), 0);
});

// ── archiveBlurb ─────────────────────────────────────────────────────────────

const blurbText = (tables: PublicArchiveTable[]): string => {
  const { lead, emphasis, tail } = archiveBlurb(tables);
  return `${lead}${emphasis}${tail}`;
};

test("archiveBlurb: one table", () => {
  assert.equal(
    blurbText([{ table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 }]),
    "Off to the right, one column per archived table — old rows of T1 api_logs leave Postgres for " +
      "permanent per-week archive objects: archived once 4 weeks old, deleted from the database once 13 weeks old.",
  );
});

test("archiveBlurb: two tables on the same windows share one clause", () => {
  assert.equal(
    blurbText([
      { table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 },
      { table: "audit_events", archiveAfterWeeks: 4, pruneAfterWeeks: 13 },
    ]),
    "Off to the right, one column per archived table — old rows of T1 api_logs and T2 audit_events leave " +
      "Postgres for permanent per-week archive objects: archived once 4 weeks old, deleted from the database once 13 weeks old.",
  );
});

test("archiveBlurb: differing windows are listed per table", () => {
  assert.equal(
    blurbText([
      { table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 },
      { table: "audit_events", archiveAfterWeeks: 8, pruneAfterWeeks: 26 },
    ]),
    "Off to the right, one column per archived table — old rows of T1 api_logs and T2 audit_events leave " +
      "Postgres for permanent per-week archive objects, each on its own schedule: api_logs archived once 4 weeks " +
      "old and deleted once 13 weeks old; audit_events archived once 8 weeks old and deleted once 26 weeks old.",
  );
});

test("archiveBlurb: a log-only table keeps its column but is left out of the schedule clause", () => {
  assert.equal(
    blurbText([
      { table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 },
      { table: "audit_events", archiveAfterWeeks: null, pruneAfterWeeks: null },
    ]),
    "Off to the right, one column per archived table — old rows of T1 api_logs and T2 audit_events leave " +
      "Postgres for permanent per-week archive objects, each on its own schedule: api_logs archived once 4 weeks " +
      "old and deleted once 13 weeks old.",
  );
  // Nothing knowable at all → no schedule clause to fake.
  assert.equal(
    blurbText([{ table: "api_logs", archiveAfterWeeks: null, pruneAfterWeeks: null }]),
    "Off to the right, one column per archived table — old rows of T1 api_logs leave Postgres for " +
      "permanent per-week archive objects.",
  );
});

test("archiveBlurb: a one-week window is singular", () => {
  assert.match(
    blurbText([{ table: "api_logs", archiveAfterWeeks: 1, pruneAfterWeeks: 1 }]),
    /archived once 1 week old, deleted from the database once 1 week old\.$/,
  );
});
