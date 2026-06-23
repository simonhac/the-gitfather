// ─────────────────────────────────────────────────────────────────────────────
// Pure GFS scheduling helpers — extracted so the UTC tier math (the easiest thing to
// get subtly wrong) is unit-testable. All computed in UTC, matching the bash scripts.
// ─────────────────────────────────────────────────────────────────────────────

import type { RunOrigin } from "./backupTypes.js";

/**
 * Classify a run's origin for the Slack-row marker. `eventName` = GITHUB_EVENT_NAME; `reason` =
 * BACKUP_TRIGGER (threaded from the caller's workflow_dispatch `reason` input). A scheduled cron run →
 * "schedule" (no marker). Anything else (workflow_dispatch / local) → "manual", unless the self-heal
 * tagged it `reason=self-heal` → "self-heal". Supersedes the old isManualRun boolean.
 */
export function runOrigin(eventName: string | undefined, reason: string | undefined): RunOrigin {
  if (eventName === "schedule") return "schedule";
  return reason === "self-heal" ? "self-heal" : "manual";
}

/**
 * Tiers this run belongs to. Always 2hourly; the anchor-hour run is also daily, +weekly on Sunday,
 * +monthly on the 1st — all in UTC. A non-empty `forced` (FORCE_TIERS) overrides the computation.
 * NB: bash `%u` makes Sunday=7; JS getUTCDay() makes Sunday=0 — hence the `=== 0` check.
 */
export function computeTiers(now: Date, anchorHour: number, forced: string[] = []): string[] {
  if (forced.length) return forced;
  const tiers = ["2hourly"];
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
 * Is the current cadence slot's backup overdue? `slotMs` is aligned to the Unix epoch, so a
 * 120-minute slot puts the boundaries on even UTC hours — matching a two-hourly backup cron. A slot
 * is "satisfied" once an object stamped at-or-after its boundary exists; it counts as "overdue" only
 * once the boundary has passed AND the grace window has elapsed AND nothing has landed for it. This
 * decouples self-heal recovery time (≈ grace) from the backup interval — see check-staleness.ts.
 * Pure + UTC, like the rest of this module (unit-tested in schedule.test.ts).
 */
export function slotState(
  nowMs: number,
  newestEpochMs: number,
  slotMinutes: number,
  graceMinutes: number,
): { overdue: boolean; landed: boolean; slotStartMs: number; dueMs: number } {
  const slotMs = slotMinutes * 60_000;
  const slotStartMs = Math.floor(nowMs / slotMs) * slotMs;
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
