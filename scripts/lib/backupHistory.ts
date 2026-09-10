// ─────────────────────────────────────────────────────────────────────────────
// GFS-aware cell-state derivation + grid assembly for the dashboard heatmap.
// Environment-agnostic (Intl only) — shared by build-dashboard.ts (Node) and the
// browser bundle (dashboard/heatmap.ts). Operates on the scrubbed PublicPayload.
// ─────────────────────────────────────────────────────────────────────────────

import {
  DEFAULT_RETENTION,
  DISPLAY_TZ,
  SLOTS_PER_DAY,
  HOURS_PER_SLOT,
  DAYS_PER_WEEK,
  type RetentionMap,
  type PublicRun,
  type PublicVerification,
  type PublicPayload,
  type PublicArchiveRun,
  type BackupCellState,
  type BackupBodyState,
  type SlotRun,
  type BackupCell,
  type BackupRow,
  type BackupGrid,
  type BackupStats,
  type ArchiveCellState,
  type ArchiveSlotRun,
  type ArchiveCell,
  type ArchiveColumns,
  type ArchiveStats,
} from "./backupTypes.js";
import { summarizeOutcomes, type OutcomeCode } from "./outcomes.js";
import { tzAbbrev } from "./tzAbbrev.js";
import { tzPartsIn, type TzParts } from "./dailyRow.js";

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Display-timezone calendar helpers (DST-safe day/week bucketing) ──────────
// All bucketing is done in DISPLAY_TZ (default UTC) via Intl, so the grid is correct
// for any timezone and any DST regime.

/** Calendar parts of `d` as seen in DISPLAY_TZ (the parameterised form lives in dailyRow.ts). */
export function tzParts(d: Date): TzParts {
  return tzPartsIn(d, DISPLAY_TZ);
}

/** Days since the Unix epoch for a display-timezone calendar date (DST-safe ordinal). */
export function dateOrdinal(y: number, mo: number, day: number): number {
  return Math.floor(Date.UTC(y, mo - 1, day) / 86_400_000);
}

/** 0 = Monday … 6 = Sunday for a day ordinal. */
export function weekdayMon0(ordinal: number): number {
  return (new Date(ordinal * 86_400_000).getUTCDay() + 6) % 7;
}

/**
 * Days since the Unix epoch of the MONDAY that starts ISO week `label` ("2026-W13").
 *
 * DISPLAY_TZ deliberately does not enter. An ISO week label is a CALENDAR fact — it names seven
 * dates, not an instant — so it maps to a date ordinal directly. Converting its Monday 00:00 UTC to
 * an instant and bucketing that in a negative-offset zone lands on the previous Sunday, which would
 * shift every archive body up a row: the one bug this function exists to make impossible.
 *
 * Throws on a label that is well-formed but not a real week ("2025-W53"), because a silently
 * clamped week would put rows on a row they do not belong to.
 */
export function isoWeekMondayOrdinal(label: string): number {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new Error(`invalid ISO week label "${label}" — expected e.g. "2026-W23"`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  const weeks = isoWeeksInYear(year);
  if (week < 1 || week > weeks) {
    throw new Error(`invalid ISO week label "${label}" — ${year} has ${weeks} ISO weeks`);
  }
  // ISO week 1 is the week containing 4 January, by definition.
  const jan4 = dateOrdinal(year, 1, 4);
  return jan4 - weekdayMon0(jan4) + (week - 1) * DAYS_PER_WEEK;
}

/**
 * 53 when the ISO year has a 53rd week — 1 January a Thursday, or a Wednesday in a leap year.
 *
 * lib/archive.ts has the same function, but that module imports `node:crypto` and so can never be
 * pulled into the browser bundle. A unit test walks 400 weeks through both to pin the agreement.
 */
function isoWeeksInYear(year: number): number {
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay(); // 0=Sun … 4=Thu
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return jan1 === 4 || (leap && jan1 === 3) ? 53 : 52;
}

function ordinalToDate(ordinal: number): { y: number; mo: number; day: number } {
  const d = new Date(ordinal * 86_400_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Week-start label in D MMM YY, e.g. "7 Jun 27" — no leading zero, the labels are right-aligned. */
export function weekStartLabel(ordinal: number): string {
  const { y, mo, day } = ordinalToDate(ordinal);
  return `${day} ${MONTH_SHORT[mo - 1]} ${String(y).slice(-2)}`;
}

/**
 * The ordinal of the Monday that starts the week containing `now`, in DISPLAY_TZ — the origin every
 * grid row is measured back from.
 */
export function currentWeekStartOrdinal(now: Date): number {
  const p = tzParts(now);
  const ord = dateOrdinal(p.y, p.mo, p.day);
  return ord - weekdayMon0(ord);
}

/**
 * Where a timestamp lands on the grid, as seen in DISPLAY_TZ: `row` 0 is the current week (top) and
 * grows going back in time, `weekday` is 0=Mon…6=Sun, `slot` is the display slot within that day.
 *
 * Shared by the backup grid and the archive columns so a run and the archive that ran hours later
 * cannot disagree about which week they are in — which is the whole point of putting the archive
 * cells on the same rows.
 */
export function weekRowOf(d: Date, currentWeekStart: number): { row: number; weekday: number; slot: number } {
  const p = tzParts(d);
  const ord = dateOrdinal(p.y, p.mo, p.day);
  const weekday = weekdayMon0(ord);
  return {
    row: (currentWeekStart - (ord - weekday)) / DAYS_PER_WEEK,
    weekday,
    slot: Math.floor(p.hour / HOURS_PER_SLOT),
  };
}

const whenFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "Wed 19 Jun 2026, 2:00 am UTC" (narrow no-break spaces normalised). */
export function formatInTz(d: Date): string {
  const base = whenFmt.format(d).replace(/\u202f/g, " ");
  const tz = tzAbbrev(d, DISPLAY_TZ);
  return tz ? `${base} ${tz}` : base;
}

/** Offset (ms) of DISPLAY_TZ from UTC at the instant `d` (positive = ahead of UTC). */
function tzOffsetMs(d: Date): number {
  const p = tzParts(d);
  return Date.UTC(p.y, p.mo - 1, p.day, p.hour, 0) - Math.floor(d.getTime() / 3_600_000) * 3_600_000;
}

/** Approximate Date for an empty slot's start — only used for its tooltip label. */
export function slotApproxDate(weekStartOrdinal: number, weekday: number, slot: number): Date {
  const { y, mo, day } = ordinalToDate(weekStartOrdinal + weekday);
  // Treat the wall-clock as UTC, then correct by the tz offset at that instant.
  const guessUtc = Date.UTC(y, mo - 1, day, slot * HOURS_PER_SLOT, 0);
  return new Date(guessUtc - tzOffsetMs(new Date(guessUtc)));
}

// ── Retention / state derivation ─────────────────────────────────────────────

export function retainedUntil(run: PublicRun, retention: RetentionMap = DEFAULT_RETENTION): number {
  const start = Date.parse(run.t);
  const maxDays = run.tiers.reduce((m, t) => Math.max(m, retention[t]?.days ?? 0), 0);
  return start + maxDays * 86_400_000;
}

export function deriveState(
  run: PublicRun | null,
  verification: PublicVerification | null,
  now: number,
  retention: RetentionMap = DEFAULT_RETENTION,
): BackupCellState {
  if (!run) return "empty";
  if (!run.ok) return "failed";
  if (now >= retainedUntil(run, retention)) return "expired";
  // A matching verification that FAILED → "unverified" (amber): the backup exists but a restore/hash
  // drill failed. run.ok short-circuited above, so this can never be confused with a failed BACKUP.
  return verification ? (verification.ok ? "verified" : "unverified") : "ok";
}

/**
 * One run's outcome CODE — the mark channel's atom.
 *
 * Read from the run and its matched verification rather than from `SlotRun.state`, because
 * `deriveState` reports `expired` before it ever looks at the verification: an aged-out dump whose
 * drill failed would otherwise lose its amber.
 *
 * Folding the drill into its run is deliberate: a lone backup whose drill failed is ONE action that
 * went half-right, so it reads as a single amber bar rather than as "mixed".
 */
export function backupCode(sr: { run: { ok: boolean }; verification: { ok: boolean } | null }): OutcomeCode {
  if (!sr.run.ok) return "failed";
  if (sr.verification && !sr.verification.ok) return "attention";
  return "ok";
}

/**
 * What one run contributes to the BODY — what we hold because of it, or null when it produced
 * nothing. `unverified` maps to `ok` because a dump whose drill failed is still a dump; the amber
 * has moved to the mark, where it can coexist with the green.
 */
export function runBodyState(state: BackupCellState): BackupBodyState | null {
  switch (state) {
    case "verified":
      return "verified";
    case "ok":
    case "unverified":
      return "ok";
    case "expired":
      return "expired";
    default:
      return null; // failed | empty — no data to show
  }
}

/** Best of two bodies: a verified copy outranks a plain one, which outranks an expired one. */
const BODY_RANK: Record<BackupBodyState, number> = { verified: 3, ok: 2, expired: 1 };

/**
 * Bytes currently sitting in R2. Each tier a run was promoted to is a separate object
 * (the backup is server-side copied into 2hourly/daily/weekly/monthly), and each copy
 * expires independently by its own lifecycle rule — so a run still contributes one
 * copy's worth of bytes per tier whose retention window hasn't elapsed.
 *
 * Archive objects are included: they live in the same bucket and land on the same bill, and they
 * never expire, so leaving them out would understate both the size and the cost of the thing.
 */
export function storedBytes(payload: PublicPayload, now: number): number {
  const retention = payload.retention ?? DEFAULT_RETENTION;
  let total = 0;
  for (const run of payload.runs) {
    if (!run.ok || run.bytes == null) continue;
    const start = Date.parse(run.t);
    for (const tier of run.tiers) {
      if (now < start + (retention[tier]?.days ?? 0) * 86_400_000) total += run.bytes;
    }
  }
  return total + archiveStoredBytes(payload);
}

/**
 * Cumulative bytes of archive objects ever written. Unlike a backup, an archive is not a copy of
 * something that still exists — it IS the rows, and it has no lifecycle rule behind it — so every
 * byte ever written is still there and the sum runs over the whole payload, not the visible window.
 */
export function archiveStoredBytes(payload: PublicPayload): number {
  let total = 0;
  for (const run of payload.archive?.runs ?? []) {
    // A dry run reports the bytes it WOULD have written; nothing reached the bucket.
    if (!run.ok || run.dryRun !== "none" || run.bytes == null) continue;
    total += run.bytes;
  }
  return total;
}

/** Cloudflare R2 Standard storage, USD per GB-month (https://developers.cloudflare.com/r2/pricing/). */
export const R2_STORAGE_USD_PER_GB_MONTH = 0.015;
/** R2 Standard free allowance, GB-month per month. */
export const R2_FREE_GB_MONTH = 10;

/** Estimated R2 storage cost per month for `bytes` at rest, after the free allowance. */
export function r2MonthlyCostUsd(bytes: number): number {
  const gb = bytes / 1_000_000_000; // R2 bills in decimal GB
  return Math.max(0, gb - R2_FREE_GB_MONTH) * R2_STORAGE_USD_PER_GB_MONTH;
}

// ── Grid assembly ────────────────────────────────────────────────────────────

export function buildBackupGrid(payload: PublicPayload, now: Date, weeks = 52): BackupGrid {
  const nowMs = now.getTime();
  const retention = payload.retention ?? DEFAULT_RETENTION;

  const verByTs = new Map<string, PublicVerification>();
  for (const v of payload.verifications) {
    const k = new Date(v.vt).toISOString();
    const existing = verByTs.get(k);
    if (!existing || (v.ok && !existing.ok)) verByTs.set(k, v);
  }

  const currentWeekStart = currentWeekStartOrdinal(now);

  const rows: BackupRow[] = [];
  for (let r = 0; r < weeks; r++) {
    const weekStartOrdinal = currentWeekStart - r * DAYS_PER_WEEK;
    rows.push({
      weekStartOrdinal,
      weekStartLabel: weekStartLabel(weekStartOrdinal),
      cells: new Map<number, BackupCell>(),
    });
  }

  // Gather every run into its slot — a slot can hold several (a manual rerun landing in the same
  // display-timezone slot as the scheduled run, or the DST "fall back" hour once a year).
  const slotRuns = new Map<number, Map<number, SlotRun[]>>(); // row → col → runs
  for (const run of payload.runs) {
    const d = new Date(run.t);
    const { row, weekday, slot } = weekRowOf(d, currentWeekStart);
    if (row < 0 || row >= weeks) continue;
    const col = weekday * SLOTS_PER_DAY + slot;
    const verification = verByTs.get(d.toISOString()) ?? null;
    let byCol = slotRuns.get(row);
    if (!byCol) {
      byCol = new Map();
      slotRuns.set(row, byCol);
    }
    let arr = byCol.get(col);
    if (!arr) {
      arr = [];
      byCol.set(col, arr);
    }
    arr.push({ run, verification, state: deriveState(run, verification, nowMs, retention), whenLabel: formatInTz(d) });
  }

  // Reduce each slot to one cell, in the two channels the glyph draws: the BODY is the best thing
  // the slot holds (verified > ok > expired, null when every run failed), and the MARK is how the
  // runs went. Neither is derivable from the other — which is the point of having both.
  for (let r = 0; r < weeks; r++) {
    const byCol = slotRuns.get(r);
    if (!byCol) continue;
    for (const [col, runsIn] of byCol) {
      runsIn.sort((a, b) => Date.parse(a.run.t) - Date.parse(b.run.t));
      let body: BackupBodyState | null = null;
      for (const sr of runsIn) {
        const b = runBodyState(sr.state);
        if (b && (!body || BODY_RANK[b] > BODY_RANK[body])) body = b;
      }
      rows[r].cells.set(col, {
        row: r,
        col,
        weekday: Math.floor(col / SLOTS_PER_DAY),
        slot: col % SLOTS_PER_DAY,
        runs: runsIn,
        body,
        mark: summarizeOutcomes(runsIn.map(backupCode)),
      });
    }
  }

  return { rows, weeks };
}

export function summarize(grid: BackupGrid): BackupStats {
  const stats: BackupStats = {
    total: 0, ok: 0, verified: 0, unverified: 0, failed: 0, expired: 0, latestLabel: null, latestState: null,
  };
  let latestMs = -Infinity;
  // Count actual runs (a slot may hold several), so the totals stay honest under conflicts.
  for (const row of grid.rows) {
    for (const cell of row.cells.values()) {
      for (const sr of cell.runs) {
        stats.total++;
        if (sr.state === "verified") stats.verified++;
        else if (sr.state === "ok") stats.ok++;
        else if (sr.state === "unverified") stats.unverified++;
        else if (sr.state === "failed") stats.failed++;
        else if (sr.state === "expired") stats.expired++;
        const ms = Date.parse(sr.run.t);
        if (ms > latestMs) {
          latestMs = ms;
          stats.latestLabel = sr.whenLabel;
          stats.latestState = sr.state;
        }
      }
    }
  }
  return stats;
}

// ── Archive columns ──────────────────────────────────────────────────────────
// A sibling block to the right of the grid: one narrow column per archived table, sharing the row
// pitch. The row is the week the run HAPPENED in, not the ISO week whose data it moved — the
// run-log carries counts, not week labels, and it is the run week that puts an archive cell on the
// same row as the weekly backup it follows a few hours later.

/**
 * An archive record's cell state.
 *
 * Refusals and anomalies are tested FIRST because archive-table.ts already folds them into `ok`
 * (`ok: !failure && refusals.length === 0 && anomalies.length === 0`), so a refusal arrives as a
 * not-ok record. Painting it red would say "the job broke" when what happened is "the fingerprint
 * gate declined to delete, on purpose, and someone should look".
 */
export function deriveArchiveState(run: PublicArchiveRun): ArchiveCellState {
  if (run.refusals > 0 || run.anomalies > 0) return "attention";
  if (!run.ok) return "failed";
  // A dry run and a run with nothing eligible are the same story to a reader: it ran, the database
  // did not change. The tooltip tells them apart.
  if (run.dryRun !== "none") return "quiet";
  return run.weeksArchived + run.weeksPruned > 0 ? "archived" : "quiet";
}

/**
 * One archive run's outcome CODE. `deriveArchiveState` has already done the hard part — it checks
 * refusals and anomalies BEFORE `ok`, because archive-table.ts folds them into `ok` and a refusal is
 * a deliberate decline, not a breakage — so this is a straight mapping. `archived` and `quiet` are
 * both clean runs; whether anything was stored is the BODY's question, and the body no longer takes
 * its answer from the runs at all.
 */
export function archiveCode(sr: { state: ArchiveCellState }): OutcomeCode {
  if (sr.state === "failed") return "failed";
  if (sr.state === "attention") return "attention";
  return "ok";
}

/**
 * Assemble the archive block: one Map per week row (index-aligned with BackupGrid.rows), keyed by
 * short table name. Returns null when the profile archives nothing — the caller then renders the
 * page exactly as it did before this feature existed.
 *
 * Each cell has two channels with two different subjects, and a cell exists when EITHER has
 * something to say:
 *
 *   data  the rows DATED this week, placed by their ISO week label (`_index/`)
 *   runs  the archiver runs that EXECUTED during this week, placed by their timestamp
 *
 * They are rarely the same week. The run that archives W30's rows happens weeks later — five rows
 * above W30's body on this grid — which is why the tooltip splits the two halves with a rule.
 * Putting the runs on the week they ran is still right: it is what keeps an archive record on the
 * same row as the weekly backup it follows a few hours later.
 */
export function buildArchiveColumns(payload: PublicPayload, now: Date, weeks = 52): ArchiveColumns | null {
  const archive = payload.archive;
  if (!archive || archive.tables.length === 0) return null;

  const tables = archive.tables.map((t) => t.table);
  const known = new Set(tables);
  const currentWeekStart = currentWeekStartOrdinal(now);

  // row → table → the two channels, accumulated independently.
  interface Channels {
    runs: ArchiveSlotRun[];
    data: ArchiveCell["data"];
  }
  const byRow = new Map<number, Map<string, Channels>>();
  const channelsAt = (row: number, table: string): Channels => {
    let byTable = byRow.get(row);
    if (!byTable) {
      byTable = new Map();
      byRow.set(row, byTable);
    }
    let ch = byTable.get(table);
    if (!ch) {
      ch = { runs: [], data: null };
      byTable.set(table, ch);
    }
    return ch;
  };

  for (const run of archive.runs) {
    if (!known.has(run.table)) continue; // build-dashboard unions log-only tables in, so this is a guard
    const d = new Date(run.t);
    const { row } = weekRowOf(d, currentWeekStart);
    if (row < 0 || row >= weeks) continue;
    channelsAt(row, run.table).runs.push({ run, state: deriveArchiveState(run), whenLabel: formatInTz(d) });
  }

  // `weeks` absent = the index was not read this build; `[]` = it was read and is empty. Neither
  // draws a body, but only the second is knowledge.
  for (const w of archive.weeks ?? []) {
    if (!known.has(w.table)) continue;
    let monday: number;
    try {
      monday = isoWeekMondayOrdinal(w.week);
    } catch {
      continue; // an impossible label costs its own week, not the block
    }
    const row = (currentWeekStart - monday) / DAYS_PER_WEEK;
    if (row < 0 || row >= weeks) continue;
    channelsAt(row, w.table).data = {
      state: w.state,
      rows: w.rows,
      ...(w.bytes != null ? { bytes: w.bytes } : {}),
    };
  }

  const rows: Map<string, ArchiveCell>[] = [];
  for (let r = 0; r < weeks; r++) {
    const cells = new Map<string, ArchiveCell>();
    rows.push(cells);
    for (const [table, ch] of byRow.get(r) ?? []) {
      ch.runs.sort((a, b) => Date.parse(a.run.t) - Date.parse(b.run.t));
      cells.set(table, {
        row: r,
        table,
        runs: ch.runs,
        data: ch.data,
        mark: summarizeOutcomes(ch.runs.map(archiveCode)),
      });
    }
  }

  return { tables, rows };
}

/** Row/issue totals over the VISIBLE window, matching `summarize`'s scope for the backup cards. */
export function summarizeArchives(cols: ArchiveColumns): ArchiveStats {
  const stats: ArchiveStats = { rowsArchived: 0, rowsPruned: 0, issues: 0, weeksArchived: 0, weeksPruned: 0 };
  for (const row of cols.rows) {
    for (const cell of row.values()) {
      // The data channel: a week counted here is one whose ROWS are in the archive, which is a
      // different question from how many rows the runs in the window moved.
      if (cell.data) {
        stats.weeksArchived++;
        if (cell.data.state === "pruned") stats.weeksPruned++;
      }
      for (const sr of cell.runs) {
        if (sr.state === "failed" || sr.state === "attention") stats.issues++;
        if (sr.run.dryRun !== "none") continue; // a dry run moved nothing; don't count phantom rows
        stats.rowsArchived += sr.run.rowsArchived;
        stats.rowsPruned += sr.run.rowsPruned;
      }
    }
  }
  return stats;
}
