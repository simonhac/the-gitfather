// ─────────────────────────────────────────────────────────────────────────────
// GFS-aware cell-state derivation + grid assembly for the dashboard heatmap.
// Environment-agnostic (Intl only) — shared by build-dashboard.ts (Node) and the
// browser bundle (dashboard/heatmap.ts). Operates on the scrubbed PublicPayload.
// ─────────────────────────────────────────────────────────────────────────────

import {
  TIER_RETENTION_DAYS,
  DISPLAY_TZ,
  SLOTS_PER_DAY,
  DAYS_PER_WEEK,
  type PublicRun,
  type PublicVerification,
  type PublicPayload,
  type BackupCellState,
  type SlotRun,
  type BackupCell,
  type BackupRow,
  type BackupGrid,
  type BackupStats,
} from "./backupTypes.js";

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

const tzFmt = new Intl.DateTimeFormat("en-GB", { timeZone: DISPLAY_TZ, timeZoneName: "short" });

/** "Wed 19 Jun 2026, 2:00 am UTC" (narrow no-break spaces normalised). */
export function formatInTz(d: Date): string {
  const base = whenFmt.format(d).replace(/\u202f/g, " ");
  const tz = tzFmt.formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
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
  const guessUtc = Date.UTC(y, mo - 1, day, slot * 2, 0);
  return new Date(guessUtc - tzOffsetMs(new Date(guessUtc)));
}

// ── Retention / state derivation ─────────────────────────────────────────────

export function retainedUntil(run: PublicRun): number {
  const start = Date.parse(run.t);
  const maxDays = run.tiers.reduce((m, t) => Math.max(m, TIER_RETENTION_DAYS[t] ?? 0), 0);
  return start + maxDays * 86_400_000;
}

export function deriveState(
  run: PublicRun | null,
  verification: PublicVerification | null,
  now: number,
): BackupCellState {
  if (!run) return "empty";
  if (!run.ok) return "failed";
  if (now >= retainedUntil(run)) return "expired";
  return verification?.ok ? "verified" : "ok";
}

// ── Grid assembly ────────────────────────────────────────────────────────────

export function buildBackupGrid(payload: PublicPayload, now: Date, weeks = 58): BackupGrid {
  const nowMs = now.getTime();

  const verByTs = new Map<string, PublicVerification>();
  for (const v of payload.verifications) {
    const k = new Date(v.vt).toISOString();
    const existing = verByTs.get(k);
    if (!existing || (v.ok && !existing.ok)) verByTs.set(k, v);
  }

  const np = tzParts(now);
  const nowOrdinal = dateOrdinal(np.y, np.mo, np.day);
  const currentWeekStart = nowOrdinal - weekdayMon0(nowOrdinal);

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
  // 2-hour display-timezone bucket as the scheduled run, or the DST "fall back" hour once a year).
  const slotRuns = new Map<number, Map<number, SlotRun[]>>(); // row → col → runs
  for (const run of payload.runs) {
    const d = new Date(run.t);
    const sp = tzParts(d);
    const ord = dateOrdinal(sp.y, sp.mo, sp.day);
    const wd = weekdayMon0(ord);
    const slot = Math.floor(sp.hour / 2);
    const row = (currentWeekStart - (ord - wd)) / DAYS_PER_WEEK;
    if (row < 0 || row >= weeks) continue;
    const col = wd * SLOTS_PER_DAY + slot;
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
    arr.push({ run, verification, state: deriveState(run, verification, nowMs), whenLabel: formatInTz(d) });
  }

  // Reduce each slot to one cell. Headline colour = best success (verified > ok > expired); a slot
  // with both successes and failures is rendered as a diagonal split (see heatmap.ts).
  const SUCCESS_RANK: Record<string, number> = { verified: 3, ok: 2, expired: 1 };
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
    total: 0, ok: 0, verified: 0, failed: 0, expired: 0, latestLabel: null, latestState: null,
  };
  let latestMs = -Infinity;
  // Count actual runs (a slot may hold several), so the totals stay honest under conflicts.
  for (const row of grid.rows) {
    for (const cell of row.cells.values()) {
      for (const sr of cell.runs) {
        stats.total++;
        if (sr.state === "verified") stats.verified++;
        else if (sr.state === "ok") stats.ok++;
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
