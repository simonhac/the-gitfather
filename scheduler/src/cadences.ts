// Which cadences are due on a tick — pure UTC clock math, kept apart from index.ts so it can be
// tested without importing the Worker entrypoint.

import type { Cadence } from "./roster.js";

// Which cadences are due on THIS 10-min tick? All cadences are sub-harmonics of 10 minutes, so a single
// */10 trigger covers everything (1 of the free plan's 5 cron-trigger slots). All math is UTC.
// `backup` is only a CANDIDATE here: each client's own schedule (its profile's backups-per-day and
// anchor-hour-utc, published to its bucket) decides whether it is actually dispatched — see
// backupClients().
export function dueCadences(t: Date): Cadence[] {
  const due: Cadence[] = ["staleness"]; // every tick (the 10-min watchdog — runs natively, see watchdog.ts)
  const m = t.getUTCMinutes();
  const h = t.getUTCHours();
  if (m === 0) due.push("backup"); // every hour is a candidate; backupClients() filters per client
  if (h === 18 && m === 30) due.push("durableVerify"); // daily ~18:30 UTC — must be after the latest anchor hour
  // Weekly, MONDAY 00:30 UTC. The day and hour are both load-bearing, so do not move this casually:
  //   • The archiver works in ISO weeks on UTC boundaries, and a week becomes eligible at
  //     `end + N weeks` — always a Monday 00:00 UTC. The run must land just AFTER that instant. At the
  //     old Sunday 19:30 it landed 4.5h before, so every week waited a whole extra run: archive at ~5
  //     weeks instead of 4, prune at ~14 instead of 13.
  //   • Sunday is when computeTiers() promotes a dump to the `weekly` tier (at the profile's
  //     anchor-hour). Every Sunday anchor hour precedes Monday 00:30, so every delete is preceded by a
  //     durable snapshot that lives for the weekly tier's retention. The archive is the system of
  //     record, but it is not the only copy of what was just deleted.
  //   • 00:30 is also after Sunday's durableVerify (18:30), and on the half hour, so never a backup instant.
  // Opt-in per client via the roster's `cadences` (see OPT_IN_CADENCES in github.ts).
  if (t.getUTCDay() === 1 && h === 0 && m === 30) due.push("archive");
  // restoreDrill is superseded by durableVerify; dispatch it only via the manual /trigger endpoint if needed.
  return due;
}
