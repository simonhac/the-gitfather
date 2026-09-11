// ─────────────────────────────────────────────────────────────────────────────
// The scheduler's own liveness: the answer to "who watches the watchdog".
//
// The staleness watchdog is the only thing that notices a missed backup, and it runs INSIDE this
// Worker. Until now nothing watched the Worker. The per-client HEARTBEAT_URL does cover a dead
// scheduler — but only after a whole 8-hour slot elapses, and only for clients that have one.
//
// Deliberately free of Worker types so the decision logic is importable (and testable) from the
// Node-typed side of the repo. Everything here is pure.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Watchdog outcome codes. These live HERE, not in watchdog.ts, so that this module stays free of
 * Cloudflare Worker types — watchdog.ts needs `R2Bucket`, and a type-only import of it would drag
 * workers-types into the Node-typed half of the repo and break `npm run typecheck`.
 */
export type WatchdogOutcome =
  | "fresh" // current slot satisfied
  | "recovered" // fresh, and an alert episode was open → closed it with a 🟢 note
  | "stale-healed" // overdue → dispatched a catch-up backup
  | "stale-inflight" // overdue, but a backup is already queued/running → waited
  | "stale-broken" // overdue AND the two newest completed runs failed → paged, not retried
  | "stale-dry-run" // overdue; config dryRun → logged what it would do
  | "stale-no-heal" // overdue; selfHeal off → paged
  | "stale-unhealed" // overdue; the catch-up dispatch itself failed → paged
  | "broken-size" // newest object smaller than minBytes → paged, never healed
  | "no-objects" // nothing under <prefix>/2hourly/ → paged
  | "bad-stamp" // newest object's name doesn't carry a parseable stamp → paged
  | "no-config" // no _config/*/watchdog.json in the bucket yet (run the backup once)
  | "error"; // unexpected exception — logged, never propagated

export interface WatchdogRecord {
  id: string; // the roster's opaque client id
  name: string; // the backup's profile name ("" for no-config / error before a config was read)
  outcome: WatchdogOutcome;
}

/**
 * Outcomes that mean the watchdog DID NOT RUN, as opposed to running and finding a problem.
 *
 * This distinction is the whole design. `stale-broken`, `broken-size`, `no-objects` and friends all
 * mean the watchdog looked, formed a verdict and paged — it is working, and Slack's job is to say
 * the backup is broken. Treating those as "unhealthy" would make this heartbeat a noisy duplicate
 * of the Slack alert, and worse, would take the scheduler's liveness signal down at exactly the
 * moment a backup needs attention.
 *
 * `error` means an unexpected exception; `no-config` means the bucket has no published watchdog
 * config, so there was nothing to check. Neither is evidence the scheduler is doing its job.
 */
const NOT_A_VERDICT: ReadonlySet<WatchdogOutcome> = new Set<WatchdogOutcome>(["error", "no-config"]);

/**
 * Did this tick actually deliver? True only when EVERY rostered client produced a real verdict.
 *
 * Not "the Worker woke up": `scheduled()` runs perfectly happily with an invalid ROSTER, revoked
 * GitHub App auth, or a watchdog throwing on every client. A heartbeat that pings on mere
 * invocation would stay green through all three — the same trap as liveone's collector, where a
 * run-completed ping would have stayed green while every store failed.
 *
 * `expected` is passed separately rather than derived from `watchdog` so that a client silently
 * dropping out of the results is caught, not averaged away.
 */
export function tickDelivered(watchdog: readonly WatchdogRecord[], expected: readonly string[]): boolean {
  if (expected.length === 0) return false; // an empty roster is a misconfiguration, not health
  const verdicts = new Map(watchdog.map((w) => [w.id, w.outcome]));
  return expected.every((id) => {
    const outcome = verdicts.get(id);
    return outcome !== undefined && !NOT_A_VERDICT.has(outcome);
  });
}

/** Age of the last recorded tick, in ms. Infinity when there is no usable state. */
export function tickAgeMs(lastTickIso: string | null | undefined, now: Date): number {
  if (!lastTickIso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(lastTickIso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return now.getTime() - t;
}

/**
 * 25 minutes: the cron fires every 10, so this tolerates two consecutive misses before calling it.
 * Cloudflare Cron Triggers are best-effort and a single skipped tick is normal.
 */
export const HEALTH_MAX_TICK_AGE_MS = 25 * 60 * 1000;

export interface HealthVerdict {
  status: number;
  body: { ok: boolean; lastTick: string | null; ageSeconds: number | null; roster: number; reason?: string };
}

/**
 * Stateful /health.
 *
 * The old version returned a constant "ok", which is false comfort: a Worker's fetch handler answers
 * even when its Cron Trigger has been deleted, its ROSTER is invalid, or its App key is revoked —
 * i.e. it was green through exactly the outages worth knowing about.
 *
 * Reading the last tick makes it meaningful AND independent of the heartbeat: the heartbeat is
 * Cloudflare→BetterStack, this is BetterStack→Cloudflare, so a monitor here survives the Worker
 * losing outbound fetch, which would silence the heartbeat.
 */
export function healthVerdict(
  lastTickIso: string | null | undefined,
  rosterSize: number,
  now: Date,
  maxAgeMs: number = HEALTH_MAX_TICK_AGE_MS,
): HealthVerdict {
  const age = tickAgeMs(lastTickIso, now);
  const ageSeconds = Number.isFinite(age) ? Math.round(age / 1000) : null;
  if (!Number.isFinite(age)) {
    return { status: 503, body: { ok: false, lastTick: null, ageSeconds: null, roster: rosterSize, reason: "no tick recorded" } };
  }
  if (age > maxAgeMs) {
    return {
      status: 503,
      body: { ok: false, lastTick: lastTickIso ?? null, ageSeconds, roster: rosterSize, reason: "last tick is stale" },
    };
  }
  return { status: 200, body: { ok: true, lastTick: lastTickIso ?? null, ageSeconds, roster: rosterSize } };
}
