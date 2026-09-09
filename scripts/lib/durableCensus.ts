// ─────────────────────────────────────────────────────────────────────────────
// Durable-tier census — what the run-log says SHOULD still be sitting in R2.
//
// The durable enumeration in verify-durable-pg.ts is a FILTERED rclone listing, and a filtered
// listing cannot tell "there is nothing there" apart from "I could not see it". It has already got
// this wrong once: the filter was pinned to the CURRENTLY configured encryption extension, so the
// day a profile switched `encryption: none → age` every pre-switch `.dump` object went invisible
// and the run reported green having verified one object out of thirty-five.
//
// So the listing gets an independent second opinion. The run-log records every promotion, and the
// retention windows say when R2 lifecycle is allowed to remove one; together they give a FLOOR the
// listing must clear. It is deliberately a floor and not an exact census — records predating the
// `key` field are skipped, and the last `graceDays` of each window are conceded, because R2
// lifecycle expiry is asynchronous and an object at the very edge may legitimately have just gone.
// ─────────────────────────────────────────────────────────────────────────────

import { basename } from "node:path";
import type { BackupTier, LogRun, RetentionMap } from "./backupTypes.js";

/** The tiers verify-durable is responsible for. `2hourly` is the write tier, not a durable copy. */
export const DURABLE_TIERS: readonly BackupTier[] = ["daily", "weekly", "monthly"];

const DAY_MS = 86_400_000;

/**
 * Durable object keys (`<tier>/<name>`) the run-log says should still exist, sorted and deduped.
 *
 * @param graceDays conceded at the OLD edge of each retention window — an object that far from
 *   expiry may already have been swept by an asynchronous lifecycle rule, so it is not owed.
 */
export function expectedDurableKeys(
  runs: readonly LogRun[],
  retention: RetentionMap,
  nowMs: number,
  graceDays = 1,
): string[] {
  const keys = new Set<string>();
  for (const run of runs) {
    if (!run.ok || !run.key) continue; // a failed run promises nothing; a keyless record is pre-`key`
    const startMs = Date.parse(run.ts);
    if (Number.isNaN(startMs)) continue;
    const name = basename(run.key);
    for (const tier of run.tiers) {
      if (!DURABLE_TIERS.includes(tier)) continue;
      const windowDays = (retention[tier]?.days ?? 0) - graceDays;
      if (windowDays <= 0) continue;
      if (nowMs - startMs <= windowDays * DAY_MS) keys.add(`${tier}/${name}`);
    }
  }
  return [...keys].sort();
}
