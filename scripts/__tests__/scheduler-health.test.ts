import { test } from "node:test";
import assert from "node:assert/strict";
// Import ONLY from health.ts. watchdog.ts needs Cloudflare Worker types (R2Bucket), and pulling it
// into this Node-typed test would drag workers-types into the root tsconfig and break typecheck.
import {
  tickDelivered,
  tickAgeMs,
  healthVerdict,
  slackHealth,
  HEALTH_MAX_TICK_AGE_MS,
  type WatchdogRecord,
  type CronTickRecord,
  type SlackTickRecord,
} from "../../scheduler/src/health.js";

const rec = (id: string, outcome: WatchdogRecord["outcome"], name = id): WatchdogRecord => ({ id, name, outcome });
const cron = (tick: string, delivered = true): CronTickRecord => ({ tick, delivered });
const ROSTER = ["alpha", "gamma", "beta"];

test("tickDelivered: a full set of real verdicts is delivery", () => {
  assert.equal(
    tickDelivered([rec("alpha", "fresh"), rec("gamma", "fresh"), rec("beta", "fresh")], ROSTER),
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
      tickDelivered([rec("alpha", bad), rec("gamma", "fresh"), rec("beta", "recovered")], ROSTER),
      true,
      `${bad} should still ping`,
    );
  }
});

test("tickDelivered: `error` and `no-config` mean the watchdog did NOT run", () => {
  assert.equal(tickDelivered([rec("alpha", "error"), rec("gamma", "fresh"), rec("beta", "fresh")], ROSTER), false);
  assert.equal(tickDelivered([rec("alpha", "no-config"), rec("gamma", "fresh"), rec("beta", "fresh")], ROSTER), false);
});

test("tickDelivered: a client silently missing from the results is NOT delivery", () => {
  // The failure this exists to catch: a client drops out of the roster or the watchdog never reaches
  // it, and the remaining two look perfect. Averaging over what came back would hide it.
  assert.equal(tickDelivered([rec("alpha", "fresh"), rec("gamma", "fresh")], ROSTER), false);
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

  const fresh = healthVerdict(cron("2026-09-11T23:52:00Z"), 3, now); // 8 min
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.ok, true);
  assert.equal(fresh.body.ageSeconds, 480);
  assert.equal(fresh.body.roster, 3);

  // 25 min tolerates two consecutive missed ticks; Cron Triggers are best-effort and one skip is normal.
  const twoMissed = healthVerdict(cron("2026-09-11T23:38:00Z"), 3, now); // 22 min
  assert.equal(twoMissed.status, 200);

  const stale = healthVerdict(cron("2026-09-11T23:30:00Z"), 3, now); // 30 min
  assert.equal(stale.status, 503);
  assert.equal(stale.body.ok, false);
  assert.match(stale.body.reason ?? "", /stale/);

  const none = healthVerdict(null, 0, now);
  assert.equal(none.status, 503);
  assert.equal(none.body.lastTick, null);
  assert.match(none.body.reason ?? "", /no cron tick/);
});

test("healthVerdict: the boundary is exclusive, so exactly-max is still healthy", () => {
  const now = new Date("2026-09-12T00:00:00Z");
  const at = new Date(now.getTime() - HEALTH_MAX_TICK_AGE_MS).toISOString();
  assert.equal(healthVerdict(cron(at), 3, now).status, 200);
  const past = new Date(now.getTime() - HEALTH_MAX_TICK_AGE_MS - 1000).toISOString();
  assert.equal(healthVerdict(cron(past), 3, now).status, 503);
});

// ─── regression tests for what a review caught (2026-09-12) ────────────────────────────────────

test("tickDelivered: ONE CLIENT CAN YIELD SEVERAL RECORDS — a failed profile must not be masked", () => {
  // runWatchdogs() flattens one record per published watchdog config, so a client backing up two
  // databases produces two records with the same id. Keying a Map by id kept only the LAST, so this
  // read as delivered and the reversed order read as not — a false green on a dead-man's switch,
  // order-dependent. Both orders must now be false.
  const twoProfiles = ["alpha"];
  assert.equal(
    tickDelivered([rec("alpha", "error", "db-a"), rec("alpha", "fresh", "db-b")], twoProfiles),
    false,
    "error first",
  );
  assert.equal(
    tickDelivered([rec("alpha", "fresh", "db-b"), rec("alpha", "error", "db-a")], twoProfiles),
    false,
    "error last — this is the order the old Map-by-id silently accepted",
  );
  // Both healthy is still delivery.
  assert.equal(
    tickDelivered([rec("alpha", "fresh", "db-a"), rec("alpha", "recovered", "db-b")], twoProfiles),
    true,
  );
});

test("healthVerdict: a tick that RAN but did not DELIVER is not health", () => {
  // An all-`error` tick still writes a cron record. Checking only the timestamp would keep /health
  // green forever while nothing was actually being watched.
  const now = new Date("2026-09-12T00:00:00Z");
  const v = healthVerdict(cron("2026-09-11T23:55:00Z", false), 3, now);
  assert.equal(v.status, 503);
  assert.equal(v.body.delivered, false);
  assert.match(v.body.reason ?? "", /did not deliver/);
});

test("healthVerdict: an empty or unparseable roster is a misconfiguration, not health", () => {
  const now = new Date("2026-09-12T00:00:00Z");
  const v = healthVerdict(cron("2026-09-11T23:55:00Z"), 0, now);
  assert.equal(v.status, 503);
  assert.match(v.body.reason ?? "", /roster/);
});

test("healthVerdict: a future timestamp is rejected, not treated as fresh", () => {
  // Otherwise a bogus/skewed future tick reads healthy for 25 minutes BEYOND that future instant.
  const now = new Date("2026-09-12T00:00:00Z");
  const v = healthVerdict(cron("2026-09-12T02:00:00Z"), 3, now);
  assert.equal(v.status, 503);
  assert.match(v.body.reason ?? "", /future/);
});

// ── Slack: the Worker is the only thing that posts, so a dead Slack must show on /health ───────────

const slackTick = (tick: string, authOk: boolean | null = true, authError?: string): SlackTickRecord => ({
  tick,
  authCheckedAt: tick,
  authOk,
  ...(authError ? { authError } : {}),
});

test("slackHealth: no token configured is 'off', not a failure", () => {
  assert.deepEqual(slackHealth(null, false, new Date()), { ok: true, state: "off" });
});

test("slackHealth: a missing record is a failure (it is what a missing second cron looks like)", () => {
  const h = slackHealth(null, true, new Date());
  assert.equal(h.ok, false);
  assert.equal(h.reason, "no Slack tick recorded");
});

test("slackHealth: stale tick and failing auth", () => {
  const now = new Date("2026-09-27T08:30:00Z");
  assert.equal(slackHealth(slackTick("2026-09-27T08:25:00Z"), true, now).ok, true);
  assert.equal(slackHealth(slackTick("2026-09-27T08:00:00Z"), true, now).reason, "Slack tick is stale");
  assert.equal(slackHealth(slackTick("2026-09-27T08:25:00Z", false, "token_revoked"), true, now).reason, "Slack auth failing: token_revoked");
  assert.equal(slackHealth(slackTick("2026-09-27T08:25:00Z", null), true, now).ok, true, "not yet checked is not a failure");
});

test("healthVerdict: a failing Slack turns /health red, after the cron checks", () => {
  const now = new Date("2026-09-11T23:58:00Z");
  const failing = { ok: false, state: "failing" as const, reason: "Slack auth failing: invalid_auth" };
  const v = healthVerdict(cron("2026-09-11T23:55:00Z"), 3, now, { slack: failing });
  assert.equal(v.status, 503);
  assert.equal(v.body.reason, "Slack auth failing: invalid_auth");
  assert.equal(v.body.slack, "failing");
  // A dead cron is still reported as the dead cron.
  assert.equal(healthVerdict(cron("2026-09-11T23:00:00Z"), 3, now, { slack: failing }).body.reason, "last cron tick is stale");
  const ok = healthVerdict(cron("2026-09-11T23:55:00Z"), 3, now, { slack: { ok: true, state: "ok" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.slack, "ok");
});
