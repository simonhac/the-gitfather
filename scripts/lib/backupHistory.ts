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
import { tzAbbrev } from "./tzAbbrev.js";

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Display-timezone calendar helpers (DST-safe day/week bucketing) ──────────
// All bucketing is done in DISPLAY_TZ (default UTC) via Intl, so the grid is correct
// for any timezone and any DST regime.

const tzPartsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hour12: false,
});

interface TzParts {
  y: number;
  mo: number;
  day: number;
  hour: number;
}

/** Calendar parts of `d` as seen in DISPLAY_TZ. */
export function tzParts(d: Date): TzParts {
  const parts = tzPartsFmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return { y: get("year"), mo: get("month"), day: get("day"), hour };
}

/** Days since the Unix epoch for a display-timezone calendar date (DST-safe ordinal). */
export function dateOrdinal(y: number, mo: number, day: number): number {
  return Math.floor(Date.UTC(y, mo - 1, day) / 86_400_000);
}

/** 0 = Monday … 6 = Sunday for a day ordinal. */
export function weekdayMon0(ordinal: number): number {
  return (new Date(ordinal * 86_400_000).getUTCDay() + 6) % 7;
}

function ordinalToDate(ordinal: number): { y: number; mo: number; day: number } {
  const d = new Date(ordinal * 86_400_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Week-start label in DD MMM YY, e.g. "07 Jun 27". */
export function weekStartLabel(ordinal: number): string {
  const { y, mo, day } = ordinalToDate(ordinal);
  return `${String(day).padStart(2, "0")} ${MONTH_SHORT[mo - 1]} ${String(y).slice(-2)}`;
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
  const tz = tzAbbrev(d);
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

  // Reduce each slot to one cell. Headline state = best success (verified > ok > expired), which
  // becomes the cell's BODY; the runs' outcomes become its mark (see cellGlyph.ts).
  const SUCCESS_RANK: Record<string, number> = { verified: 4, ok: 3, unverified: 2, expired: 1 };
  for (let r = 0; r < weeks; r++) {
    const byCol = slotRuns.get(r);
    if (!byCol) continue;
    for (const [col, runsIn] of byCol) {
      runsIn.sort((a, b) => Date.parse(a.run.t) - Date.parse(b.run.t));
      let successState: BackupCellState | null = null;
      let hasFailure = false;
      for (const sr of runsIn) {
        if (sr.state === "failed") hasFailure = true;
        else if (!successState || SUCCESS_RANK[sr.state] > SUCCESS_RANK[successState]) successState = sr.state;
      }
      rows[r].cells.set(col, {
        row: r,
        col,
        weekday: Math.floor(col / SLOTS_PER_DAY),
        slot: col % SLOTS_PER_DAY,
        runs: runsIn,
        state: successState ?? "failed",
        successState,
        hasFailure,
        multiple: runsIn.length > 1,
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

/** Better of two untroubled states; `archived` outranks `quiet`. */
const ARCHIVE_SUCCESS_RANK: Record<string, number> = { archived: 2, quiet: 1 };
/** Worse of two troubled states; a failed run outranks a refusal. */
const ARCHIVE_PROBLEM_RANK: Record<string, number> = { failed: 2, attention: 1 };

/**
 * Assemble the archive block: one Map per week row (index-aligned with BackupGrid.rows), keyed by
 * short table name. Returns null when the profile archives nothing — the caller then renders the
 * page exactly as it did before this feature existed.
 */
export function buildArchiveColumns(payload: PublicPayload, now: Date, weeks = 52): ArchiveColumns | null {
  const archive = payload.archive;
  if (!archive || archive.tables.length === 0) return null;

  const tables = archive.tables.map((t) => t.table);
  const known = new Set(tables);
  const currentWeekStart = currentWeekStartOrdinal(now);

  // row → table → records
  const byRow = new Map<number, Map<string, ArchiveSlotRun[]>>();
  for (const run of archive.runs) {
    if (!known.has(run.table)) continue; // build-dashboard unions log-only tables in, so this is a guard
    const d = new Date(run.t);
    const { row } = weekRowOf(d, currentWeekStart);
    if (row < 0 || row >= weeks) continue;
    let byTable = byRow.get(row);
    if (!byTable) {
      byTable = new Map();
      byRow.set(row, byTable);
    }
    let arr = byTable.get(run.table);
    if (!arr) {
      arr = [];
      byTable.set(run.table, arr);
    }
    arr.push({ run, state: deriveArchiveState(run), whenLabel: formatInTz(d) });
  }

  const rows: Map<string, ArchiveCell>[] = [];
  for (let r = 0; r < weeks; r++) {
    const cells = new Map<string, ArchiveCell>();
    rows.push(cells);
    const byTable = byRow.get(r);
    if (!byTable) continue;
    for (const [table, runsIn] of byTable) {
      runsIn.sort((a, b) => Date.parse(a.run.t) - Date.parse(b.run.t));
      let successState: ArchiveCellState | null = null;
      let problemState: ArchiveCellState | null = null;
      for (const sr of runsIn) {
        if (sr.state === "failed" || sr.state === "attention") {
          if (!problemState || ARCHIVE_PROBLEM_RANK[sr.state] > ARCHIVE_PROBLEM_RANK[problemState]) problemState = sr.state;
        } else if (!successState || ARCHIVE_SUCCESS_RANK[sr.state] > ARCHIVE_SUCCESS_RANK[successState]) {
          successState = sr.state;
        }
      }
      cells.set(table, {
        row: r,
        table,
        runs: runsIn,
        // Headline follows the backup grid's convention: the success is the colour, the problem
        // shows as the split triangle. With no success at all, the problem IS the cell.
        state: successState ?? problemState ?? "failed",
        successState,
        problemState,
        multiple: runsIn.length > 1,
      });
    }
  }

  return { tables, rows };
}

/** Row/issue totals over the VISIBLE window, matching `summarize`'s scope for the backup cards. */
export function summarizeArchives(cols: ArchiveColumns): ArchiveStats {
  const stats: ArchiveStats = { rowsArchived: 0, rowsPruned: 0, issues: 0 };
  for (const row of cols.rows) {
    for (const cell of row.values()) {
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
