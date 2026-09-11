import { test } from "node:test";
import assert from "node:assert/strict";
// Import ONLY from health.ts. watchdog.ts needs Cloudflare Worker types (R2Bucket), and pulling it
// into this Node-typed test would drag workers-types into the root tsconfig and break typecheck.
import {
  tickDelivered,
  tickAgeMs,
  healthVerdict,
  HEALTH_MAX_TICK_AGE_MS,
  type WatchdogRecord,
} from "../../scheduler/src/health.js";

const rec = (id: string, outcome: WatchdogRecord["outcome"]): WatchdogRecord => ({ id, name: id, outcome });
const ROSTER = ["liveone", "mrtippy", "boost"];

test("tickDelivered: a full set of real verdicts is delivery", () => {
  assert.equal(
    tickDelivered([rec("liveone", "fresh"), rec("mrtippy", "fresh"), rec("boost", "fresh")], ROSTER),
    true,
  );
});

test("tickDelivered: a watchdog that ran and PAGED still counts as delivery", () => {
  // The whole design. These outcomes mean the watchdog looked, formed a verdict and alerted — it is
  // working. Treating them as unhealthy would make this heartbeat a noisy duplicate of the Slack
  // alert, and would drop the scheduler's liveness signal at exactly the moment a backup needs
  // attention.
  for (const bad of ["stale-broken", "stale-unhealed", "stale-no-heal", "broken-size", "no-objects", "bad-stamp"] as const) {
    assert.equal(
      tickDelivered([rec("liveone", bad), rec("mrtippy", "fresh"), rec("boost", "recovered")], ROSTER),
      true,
      `${bad} should still ping`,
    );
  }
});

test("tickDelivered: `error` and `no-config` mean the watchdog did NOT run", () => {
  assert.equal(tickDelivered([rec("liveone", "error"), rec("mrtippy", "fresh"), rec("boost", "fresh")], ROSTER), false);
  assert.equal(tickDelivered([rec("liveone", "no-config"), rec("mrtippy", "fresh"), rec("boost", "fresh")], ROSTER), false);
});

test("tickDelivered: a client silently missing from the results is NOT delivery", () => {
  // The failure this exists to catch: a client drops out of the roster or the watchdog never reaches
  // it, and the remaining two look perfect. Averaging over what came back would hide it.
  assert.equal(tickDelivered([rec("liveone", "fresh"), rec("mrtippy", "fresh")], ROSTER), false);
});

test("tickDelivered: an empty roster is a misconfiguration, not health", () => {
  // `scheduled()` runs happily with an empty ROSTER. Pinging on that would be the purest form of
  // "the Worker woke up" — green while the scheduler schedules nothing at all.
  assert.equal(tickDelivered([], []), false);
});

test("tickAgeMs: missing or unparseable state is infinitely old", () => {
  const now = new Date("2026-09-12T00:00:00Z");
  assert.equal(tickAgeMs(null, now), Number.POSITIVE_INFINITY);
  assert.equal(tickAgeMs(undefined, now), Number.POSITIVE_INFINITY);
  assert.equal(tickAgeMs("not a date", now), Number.POSITIVE_INFINITY);
  assert.equal(tickAgeMs("2026-09-11T23:50:00Z", now), 10 * 60 * 1000);
});

test("healthVerdict: 200 while ticks are recent, 503 once they stop", () => {
  const now = new Date("2026-09-12T00:00:00Z");

  const fresh = healthVerdict("2026-09-11T23:52:00Z", 3, now); // 8 min
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.ok, true);
  assert.equal(fresh.body.ageSeconds, 480);
  assert.equal(fresh.body.roster, 3);

  // 25 min tolerates two consecutive missed ticks; Cron Triggers are best-effort and one skip is normal.
  const twoMissed = healthVerdict("2026-09-11T23:38:00Z", 3, now); // 22 min
  assert.equal(twoMissed.status, 200);

  const stale = healthVerdict("2026-09-11T23:30:00Z", 3, now); // 30 min
  assert.equal(stale.status, 503);
  assert.equal(stale.body.ok, false);
  assert.match(stale.body.reason ?? "", /stale/);

  const none = healthVerdict(null, 0, now);
  assert.equal(none.status, 503);
  assert.equal(none.body.lastTick, null);
  assert.match(none.body.reason ?? "", /no tick/);
});

test("healthVerdict: the boundary is exclusive, so exactly-max is still healthy", () => {
  const now = new Date("2026-09-12T00:00:00Z");
  const at = new Date(now.getTime() - HEALTH_MAX_TICK_AGE_MS).toISOString();
  assert.equal(healthVerdict(at, 3, now).status, 200);
  const past = new Date(now.getTime() - HEALTH_MAX_TICK_AGE_MS - 1000).toISOString();
  assert.equal(healthVerdict(past, 3, now).status, 503);
});
