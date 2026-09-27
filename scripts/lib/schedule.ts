// ─────────────────────────────────────────────────────────────────────────────
// Pure GFS scheduling helpers — extracted so the UTC tier math (the easiest thing to
// get subtly wrong) is unit-testable. All computed in UTC, matching the bash scripts.
// ─────────────────────────────────────────────────────────────────────────────

import type { RunOrigin } from "./runOrigin.js";

/** Backups per day when a profile doesn't say (00/08/16 UTC at the default anchor). */
export const DEFAULT_BACKUPS_PER_DAY = 3;

/** The profile's `anchor-hour-utc` default: the run at this hour is promoted to daily/weekly/monthly. */
export const DEFAULT_ANCHOR_HOUR_UTC = 16;

/** The write tier every run lands in first; the anchor-hour run is then copied to the durable tiers. */
export const INTRADAY_TIER = "intraday";

/**
 * LEGACY: the intraday tier's old id and R2 prefix, from when the cadence was fixed at two-hourly.
 * Objects written before the rename still sit under `<prefix>/2hourly/` until the lifecycle rule
 * expires them (the grandson window, 2 days by default), and old run-log records carry it as a tier.
 * Every reader that still accepts it names this constant, so removing the transition is one grep.
 */
export const LEGACY_INTRADAY_TIER = "2hourly";

/** A run-log tier id with the legacy name mapped onto the current one. */
export const normalizeTier = (t: string): string => (t === LEGACY_INTRADAY_TIER ? INTRADAY_TIER : t);

/** Where the newest dump may be: the intraday prefix, then (transitionally) the legacy one. */
export const INTRADAY_PREFIXES: readonly string[] = [INTRADAY_TIER, LEGACY_INTRADAY_TIER];

/**
 * The newest of several object names by their `<name>-YYYYMMDDTHHMMSSZ` stamp. Names from the same
 * backup share a basename prefix, so lexical order is chronological — across prefixes too.
 */
export function newestName<T>(items: readonly T[], nameOf: (t: T) => string): T | null {
  let best: T | null = null;
  for (const it of items) if (best === null || nameOf(it) > nameOf(best)) best = it;
  return best;
}

/**
 * Minutes past midnight UTC at which the slot grid starts: slots are phased from the anchor hour, so
 * the anchor-hour run (the one promoted to daily/weekly/monthly) always opens a slot. At 3 a day with
 * anchor 16 this is 0 (00/08/16); at 1 a day it is the anchor hour itself.
 */
export function slotPhaseMinutes(slotMinutes: number, anchorHourUtc: number): number {
  return (anchorHourUtc * 60) % slotMinutes;
}

/**
 * Is `t` a scheduled backup instant for this cadence? True on the hour when the UTC hour is the anchor
 * hour plus a whole number of slots. `backupsPerDay` must divide 24 (the profile schema enforces it).
 */
export function isBackupSlot(t: Date, backupsPerDay: number, anchorHourUtc: number): boolean {
  if (t.getUTCMinutes() !== 0) return false;
  const width = 24 / backupsPerDay;
  return (((t.getUTCHours() - anchorHourUtc) % width) + width) % width === 0;
}

/**
 * Classify a run's origin for the Slack-row marker. `eventName` = GITHUB_EVENT_NAME; `reason` =
 * BACKUP_TRIGGER (threaded from the caller's workflow_dispatch `reason` input).
 *   - reason="self-heal"   → "self-heal" (🩹): the staleness watchdog's catch-up.
 *   - reason="schedule"    → "schedule" (no marker): a Cloudflare-dispatched automatic backup. It
 *     arrives as workflow_dispatch (NOT the legacy cron `schedule` event), so we key off the reason.
 *   - eventName="schedule" → "schedule" (no marker): a legacy GitHub cron run (back-compat).
 *   - anything else (workflow_dispatch with no reason / a local run) → "manual" (🖐️).
 * Supersedes the old isManualRun boolean.
 */
export function runOrigin(eventName: string | undefined, reason: string | undefined): RunOrigin {
  if (reason === "self-heal") return "self-heal";
  if (reason === "schedule" || eventName === "schedule") return "schedule";
  return "manual"; // GitHub-UI "Run workflow" (reason empty) or a local run → 🖐️
}

/** One backup's dispatch schedule, as published to the Worker (see watchdogConfig.ts). */
export interface BackupSchedule {
  slotMinutes: number;
  anchorHourUtc: number;
}

/**
 * Should the Worker dispatch this client's backup workflow at `t`? A client's bucket can hold several
 * published configs (one per database); the caller workflow is dispatched once when ANY of them is due.
 * A client that has published nothing yet — a new client, or one whose config listing failed — runs on
 * the default schedule, so its first backup can publish the real one.
 */
export function backupDue(t: Date, schedules: readonly BackupSchedule[]): boolean {
  if (schedules.length === 0) return isBackupSlot(t, DEFAULT_BACKUPS_PER_DAY, DEFAULT_ANCHOR_HOUR_UTC);
  return schedules.some((s) => isBackupSlot(t, 1440 / s.slotMinutes, s.anchorHourUtc));
}

/**
 * Tiers this run belongs to. Always intraday; the anchor-hour run is also daily, +weekly on Sunday,
 * +monthly on the 1st — all in UTC. A non-empty `forced` (FORCE_TIERS) overrides the computation.
 * NB: bash `%u` makes Sunday=7; JS getUTCDay() makes Sunday=0 — hence the `=== 0` check.
 */
export function computeTiers(now: Date, anchorHour: number, forced: string[] = []): string[] {
  if (forced.length) return forced;
  const tiers = [INTRADAY_TIER];
  if (now.getUTCHours() === anchorHour) {
    tiers.push("daily");
    if (now.getUTCDay() === 0) tiers.push("weekly");
    if (now.getUTCDate() === 1) tiers.push("monthly");
  }
  return tiers;
}

/** Epoch ms for a `YYYYMMDDTHHMMSSZ` stamp, parsed strictly as UTC (NaN if malformed). */
export function stampToEpochMs(stamp: string): number {
  return Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(9, 11)),
    Number(stamp.slice(11, 13)),
    Number(stamp.slice(13, 15)),
  );
}

/**
 * Is the current cadence slot's backup overdue? Slots are `slotMinutes` wide and start at
 * `phaseMinutes` past midnight UTC (slotPhaseMinutes — phased from the anchor hour, matching the
 * Worker's dispatch). A slot is "satisfied" once an object stamped at-or-after its boundary exists; it
 * counts as "overdue" only once the boundary has passed AND the grace window has elapsed AND nothing
 * has landed for it. This decouples self-heal recovery time (≈ grace) from the backup interval — see
 * scheduler/src/watchdog.ts. Pure + UTC, like the rest of this module (unit-tested in schedule.test.ts).
 */
export function slotState(
  nowMs: number,
  newestEpochMs: number,
  slotMinutes: number,
  graceMinutes: number,
  phaseMinutes = 0,
): { overdue: boolean; landed: boolean; slotStartMs: number; dueMs: number } {
  const slotMs = slotMinutes * 60_000;
  const phaseMs = phaseMinutes * 60_000;
  const slotStartMs = Math.floor((nowMs - phaseMs) / slotMs) * slotMs + phaseMs;
  const dueMs = slotStartMs + graceMinutes * 60_000;
  const landed = newestEpochMs >= slotStartMs; // this slot already has a backup
  const overdue = !landed && nowMs >= dueMs; // boundary + grace passed, still nothing landed
  return { overdue, landed, slotStartMs, dueMs };
}

/** Completed-run conclusions that count as a backup *not* succeeding (matches the staleness self-heal). */
export const FAILED_CONCLUSIONS = ["failure", "cancelled", "timed_out", "startup_failure"];

/**
 * Does the backup look *persistently* broken (→ page, don't self-heal) rather than just a missed tick
 * (→ retry)? `runs` is `gh run list … --json status,conclusion` output, newest-first. In-flight runs
 * (in_progress/queued, null conclusion) carry no verdict and are ignored; we judge by the most recent
 * COMPLETED runs and call it broken only when the two newest both failed.
 *
 * Why two, not one: a single failure can be a transient (a momentary DB/network blip) or an
 * eventually-consistent / out-of-order API read — re-triggering once usually clears it. Refusing to retry
 * on the *first* failure (the old behaviour) let one noisy run suppress self-heal until a backup landed by
 * other means. With two-consecutive, a lone failure still self-heals; a genuinely broken backup pages
 * after one wasted retry (the catch-up failure becomes the second consecutive failure). Pure + unit-tested.
 */
export function backupLooksBroken(runs: { status?: string; conclusion?: string | null }[]): boolean {
  const completed = runs.filter((r) => r.status === "completed").map((r) => r.conclusion ?? "");
  if (completed.length < 2) return false; // need two consecutive failures to call it broken
  return FAILED_CONCLUSIONS.includes(completed[0]) && FAILED_CONCLUSIONS.includes(completed[1]);
}
