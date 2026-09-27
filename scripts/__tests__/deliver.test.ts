import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverOutcome, notifyRun, pendingOutcomes, type DeliverDeps } from "../../scheduler/src/deliver.js";
import { upsertDailyRow } from "../../scheduler/src/dailyRowStore.js";
import { displayContext } from "../../scheduler/src/outcomeRender.js";
import { slackPortFor } from "../../scheduler/src/slackPort.js";
import type { NotifyTarget } from "../../scheduler/src/oidc.js";
import type { Client } from "../../scheduler/src/roster.js";
import { outcomeKey, type JobOutcome } from "../lib/jobOutcome.js";
import type { WatchdogConfig } from "../lib/watchdogConfig.js";
import type { DailyState } from "../lib/dailyRow.js";
import { FakeGithub, FakeSlack, FakeStore } from "./fakes/workerFakes.js";

const NOW = new Date("2026-09-27T08:05:00Z");
const client: Client = { id: "liveone", owner: "simonhac", repo: "LiveOne", installationId: 1, bucket: "LIVEONE_R2", slack: { channel: "C0TESTCHAN1" } };
const cfg: WatchdogConfig = {
  version: 1,
  name: "liveone",
  backupPrefix: "pg/sydney",
  timezone: "UTC",
  slotMinutes: 480,
  anchorHourUtc: 16,
  graceMinutes: 25,
  maxAgeHours: 10,
  repageMinutes: 60,
  minBytes: 1,
  selfHeal: true,
  dryRun: false,
  healWorkflow: "pg-backup.yml",
  alertMention: "<!here>",
  dashboardUrl: null,
  publishedAt: "",
};

const outcome = (over: Partial<JobOutcome> = {}): JobOutcome => ({
  version: 1,
  source: "job",
  job: "backup",
  name: "liveone",
  runId: "17000000001",
  runAttempt: 1,
  jobId: "50000000001",
  ok: true,
  exitCode: 0,
  startedAt: "2026-09-27T08:00:30.000Z",
  finishedAt: "2026-09-27T08:02:00.000Z",
  durationMs: 90_000,
  origin: "schedule",
  summary: { kind: "backup", tiers: ["intraday"], bytes: 1234 },
  alerts: [],
  ...over,
});

function setup(opts: { slack?: FakeSlack | null; now?: Date } = {}) {
  let now = opts.now ?? NOW;
  const store = new FakeStore(() => now);
  const slack = opts.slack === undefined ? new FakeSlack() : opts.slack;
  const github = new FakeGithub();
  const webhooks: string[] = [];
  const logs: string[] = [];
  const deps: DeliverDeps = {
    client,
    store,
    slack,
    github,
    configs: [cfg],
    webhook: async (t) => void webhooks.push(t),
    engineRepo: "simonhac/the-gitfather",
    now: () => now,
    log: (l) => void logs.push(l),
  };
  const put = (o: JobOutcome, uploaded?: Date) => {
    const key = outcomeKey(o);
    store.seed(key, JSON.stringify(o), { uploaded: uploaded ?? now });
    return key;
  };
  return { store, slack, github, webhooks, logs, deps, put, advance: (ms: number) => void (now = new Date(now.getTime() + ms)) };
}

const target = (over: Partial<NotifyTarget> = {}): NotifyTarget => ({
  client,
  job: "backup",
  runId: "17000000001",
  runAttempt: 1,
  jobId: "50000000001",
  iatMs: NOW.getTime(),
  ...over,
});

const state = (s: FakeStore, key: string) => s.objects.get(key)?.customMetadata?.["gf-state"];

test("notify: announces the run's record once; a repeat notify is a no-op", async () => {
  const { deps, put, slack, store } = setup();
  const key = put(outcome());
  assert.deepEqual(await notifyRun(deps, target()), { result: "posted", count: 1 });
  assert.equal(state(store, key), "posted");
  assert.equal(slack!.posts().length, 1, "the daily row");
  assert.deepEqual(await notifyRun(deps, target()), { result: "already_posted", count: 1 });
  assert.equal(slack!.posts().length, 1);
});

test("notify: only the named run/attempt/job is touched", async () => {
  const { deps, put, store } = setup();
  const mine = put(outcome());
  const retry = put(outcome({ runAttempt: 2 }));
  const verify = put(outcome({ job: "durableVerify", summary: null }));
  await notifyRun(deps, target());
  assert.equal(state(store, mine), "posted");
  assert.equal(state(store, retry), undefined);
  assert.equal(state(store, verify), undefined);
});

test("a failed backup ticks ❌ and threads a broadcast page under the row", async () => {
  const { deps, put, slack, webhooks, store } = setup();
  put(outcome({ ok: false, exitCode: 1, summary: null, alerts: [{ severity: "page", code: "auth_rejected", text: "credential rejected" }] }));
  await notifyRun(deps, target());
  const [row, page] = slack!.posts();
  assert.match(row.text, /❌ 08:00/);
  assert.equal(page.thread, "1000.1", "threaded under the row message");
  assert.equal(page.broadcast, true);
  assert.match(page.text, /^<!here> 🔴 .*FAILED at 08:00 — `credential rejected`/);
  assert.equal(webhooks.length, 1);
  const day = store.json("_status/liveone/2026-09-27.json") as DailyState;
  assert.equal(day.ts, "1000.1");
  assert.equal(day.channel, "C0TESTCHAN1");
});

test("concurrent deliveries of one record post exactly once", async () => {
  const { deps, put, slack } = setup();
  const key = put(outcome({ job: "restoreDrill", summary: { kind: "restoreDrill", table: "t", count: 1, ratio: 1, key: "k" } }));
  const results = await Promise.all([deliverOutcome(deps, key, { verified: true }), deliverOutcome(deps, key, { verified: true })]);
  assert.deepEqual(results.sort(), ["claimed_elsewhere", "posted"]);
  assert.equal(slack!.posts().length, 1);
});

test("a transient Slack failure leaves the claim to lapse; the next attempt after the lease retries", async () => {
  const slack = new FakeSlack();
  const { deps, put, store, advance, webhooks } = setup({ slack });
  const key = put(outcome({ job: "restoreDrill", summary: { kind: "restoreDrill", table: "t", count: 1, ratio: 1, key: "k" } }));
  slack.failures = ["ratelimited"];
  assert.equal(await deliverOutcome(deps, key, { verified: true }), "retry");
  assert.equal(state(store, key), "claimed");
  assert.equal(webhooks.length, 0);
  assert.equal(await deliverOutcome(deps, key, { verified: true }), "claimed_elsewhere", "inside the lease");
  advance(6 * 60_000);
  assert.equal(await deliverOutcome(deps, key, { verified: true }), "posted");
  assert.equal(store.objects.get(key)?.customMetadata?.["gf-state"], "posted");
});

test("repeated transient failures give up after MAX_TRIES", async () => {
  const slack = new FakeSlack();
  const { deps, put, store, advance } = setup({ slack });
  const key = put(outcome({ job: "restoreDrill", summary: { kind: "restoreDrill", table: "t", count: 1, ratio: 1, key: "k" } }));
  for (let i = 0; i < 3; i++) {
    slack.failures = ["internal_error"];
    assert.equal(await deliverOutcome(deps, key, { verified: true }), "retry");
    advance(6 * 60_000);
  }
  assert.equal(await deliverOutcome(deps, key, { verified: true }), "gave_up");
  assert.equal(state(store, key), "gave_up");
});

test("a terminal Slack error is recorded, not retried, and the webhook still fires", async () => {
  const slack = new FakeSlack();
  const { deps, put, store, webhooks } = setup({ slack });
  const key = put(outcome({ job: "durableVerify", summary: null, ok: false, exitCode: 1, alerts: [{ severity: "page", code: "hash_mismatch", text: "x" }] }));
  slack.failures = ["not_in_channel"];
  assert.equal(await deliverOutcome(deps, key, { verified: true }), "posted");
  assert.equal(state(store, key), "posted");
  assert.equal(store.objects.get(key)?.customMetadata?.["gf-error"], "not_in_channel");
  assert.equal(webhooks.length, 1);
});

test("Slack off for the client: the webhook fires, the record is closed", async () => {
  const { deps, put, store, webhooks } = setup({ slack: null });
  const key = put(outcome({ ok: false, exitCode: 1, summary: null, alerts: [{ severity: "page", code: "backup_failed", text: "boom" }] }));
  assert.equal(await deliverOutcome(deps, key, { verified: true }), "slack_off");
  assert.equal(state(store, key), "posted");
  assert.equal(webhooks.length, 1);
});

test("a malformed record, or one whose key disagrees with its body, is marked invalid", async () => {
  const { deps, store, put } = setup();
  const key = outcomeKey(outcome());
  store.seed(key, "{nope");
  assert.equal(await deliverOutcome(deps, key, { verified: true }), "invalid");
  assert.equal(state(store, key), "invalid");

  const other = put(outcome({ runId: "17000000002" }));
  store.seed(other, JSON.stringify(outcome({ runId: "17000000003" }))); // body names a different run
  assert.equal(await deliverOutcome(deps, other, { verified: true }), "invalid");
});

test("tick-found records need GitHub to vouch for their run", async () => {
  const { deps, put, github, store, slack } = setup();
  const good = put(outcome({ runId: "1" }));
  const unknown = put(outcome({ runId: "2" }));
  const stale = put(outcome({ runId: "3" }));
  const wrongWorkflow = put(outcome({ runId: "4" }));
  const engine = (file: string) => [`simonhac/the-gitfather/.github/workflows/${file}@refs/heads/main`];
  github.runs.set("1", { createdAt: "2026-09-27T07:59:00Z", referencedWorkflows: engine("pg-backup.yml") });
  github.runs.set("3", { createdAt: "2026-09-24T07:59:00Z", referencedWorkflows: engine("pg-backup.yml") });
  github.runs.set("4", { createdAt: "2026-09-27T07:59:00Z", referencedWorkflows: engine("pg-archive.yml") });

  assert.equal(await deliverOutcome(deps, good, { verified: false }), "posted");
  for (const k of [unknown, stale, wrongWorkflow]) {
    assert.equal(await deliverOutcome(deps, k, { verified: false }), "rejected", k);
    assert.equal(state(store, k), "rejected");
  }
  assert.equal(slack!.posts().length, 1);

  github.fail = true;
  const later = put(outcome({ runId: "5" }));
  assert.equal(await deliverOutcome(deps, later, { verified: false }), "retry");
  assert.equal(state(store, later), undefined, "not claimed — GitHub was asked first");
});

test("pendingOutcomes: unannounced, past the grace period, inside the window", async () => {
  const { store, put } = setup();
  const t = NOW.getTime();
  const fresh = put(outcome({ runId: "1" }), new Date(t - 60_000));
  const due = put(outcome({ runId: "2" }), new Date(t - 10 * 60_000));
  const posted = put(outcome({ runId: "3" }), new Date(t - 10 * 60_000));
  store.objects.get(posted)!.customMetadata = { "gf-state": "posted" };
  const lapsed = put(outcome({ runId: "4" }), new Date(t - 10 * 60_000));
  store.objects.get(lapsed)!.customMetadata = { "gf-state": "claimed", "gf-at": new Date(t - 6 * 60_000).toISOString() };
  const held = put(outcome({ runId: "5" }), new Date(t - 10 * 60_000));
  store.objects.get(held)!.customMetadata = { "gf-state": "claimed", "gf-at": new Date(t - 60_000).toISOString() };
  const old = put(outcome({ runId: "6", startedAt: "2026-09-25T08:00:00.000Z" }), new Date(t - 49 * 3600_000));
  store.seed("_status/_outcome/garbage.json", "{}", { uploaded: new Date(t - 3600_000) });

  const got = await pendingOutcomes(store, { sinceMs: t - 26 * 3600_000, graceMs: 3 * 60_000, nowMs: t });
  assert.deepEqual(got.sort(), [due, lapsed].sort());
  assert.ok(!got.includes(fresh) && !got.includes(old));
});

test("no record: the failed step is announced from the Actions API — once", async () => {
  const { deps, github, slack, store } = setup();
  github.jobs.set("50000000001", {
    id: 50000000001,
    startedAt: "2026-09-27T08:00:10Z",
    steps: [
      { name: "Checkout caller repo (holds the profile)", conclusion: "success" },
      { name: "Install engine deps", conclusion: "failure" },
      { name: "Dump + upload to R2", conclusion: "skipped" },
    ],
  });
  const r = await notifyRun(deps, target());
  assert.deepEqual(r, { result: "posted", count: 1 });
  const [row, page] = slack!.posts();
  assert.match(row.text, /❌ 08:00/, "a backup that never started still ticks ❌, not ⬜");
  assert.match(page.text, /FAILED at 08:00 — `step "Install engine deps" failure before the job recorded an outcome`/);
  const synthetic = [...store.objects.keys()].find((k) => k.startsWith("_status/_outcome/"))!;
  assert.equal((store.json(synthetic) as JobOutcome).source, "github");

  assert.deepEqual(await notifyRun(deps, target()), { result: "already_posted", count: 1 }, "a retried notify finds the synthetic record");
  assert.equal(slack!.posts().length, 2);
});

test("no record and no failed step: nothing to announce", async () => {
  const { deps, github, slack } = setup();
  github.jobs.set("50000000001", { id: 50000000001, startedAt: "2026-09-27T08:00:10Z", steps: [{ name: "Backfill", conclusion: "success" }] });
  assert.deepEqual(await notifyRun(deps, target({ job: "archive" })), { result: "no_outcome", count: 0 });
  assert.equal(slack!.calls.length, 0);
});

test("no record and GitHub is down: retry (so the job's curl retries)", async () => {
  const { deps, github } = setup();
  github.fail = true;
  assert.deepEqual(await notifyRun(deps, target()), { result: "retry", count: 0 });
});

// ── the daily row ────────────────────────────────────────────────────────────

const rowTarget = { stateName: "liveone", ctx: displayContext({ tz: "UTC", slotMinutes: 480, name: "liveone", dashboardUrl: null }) };

test("row: the first backup posts it, later ones update it in place", async () => {
  const { store, slack } = setup();
  await upsertDailyRow(store, slack!, rowTarget, { day: NOW, now: NOW, entry: { label: "00:00", ok: true, marker: "", origin: "schedule" } });
  await upsertDailyRow(store, slack!, rowTarget, { day: NOW, now: NOW, entry: { label: "08:00", ok: false, marker: "", origin: "manual" } });
  assert.deepEqual(
    slack!.calls.map((c) => c.kind),
    ["post", "update"],
  );
  assert.match(slack!.calls[1].text, /✅ 00:00 {2}· {2}🖐️ ❌ 08:00/);
  const s = store.json("_status/liveone/2026-09-27.json") as DailyState;
  assert.equal(s.entries.length, 2);
  assert.equal(s.text, slack!.calls[1].text);
  assert.equal(s.entries[1].manual, undefined, "the legacy field is no longer written");
});

test("row: a refresh with nothing new skips Slack; one that crosses a slot adds ⬜", async () => {
  const { store, slack } = setup();
  await upsertDailyRow(store, slack!, rowTarget, { day: NOW, now: NOW, entry: { label: "00:00", ok: true, marker: "", origin: "schedule" } });
  const r = await upsertDailyRow(store, slack!, rowTarget, { day: NOW, now: NOW });
  assert.equal(r.skipped, true);
  assert.equal(slack!.calls.length, 1);
  const evening = new Date("2026-09-27T16:05:00Z");
  await upsertDailyRow(store, slack!, rowTarget, { day: evening, now: evening });
  assert.equal(slack!.calls.length, 2);
  assert.match(slack!.calls[1].text, /⬜ 08:00/);
});

test("row: a refresh never creates an empty row", async () => {
  const { store, slack } = setup();
  assert.deepEqual(await upsertDailyRow(store, slack!, rowTarget, { day: NOW, now: NOW }), { ok: true, skipped: true });
  assert.equal(slack!.calls.length, 0);
  assert.equal(store.objects.size, 0);
});

test("row: a row another app posted (cutover day) is re-posted, then updated as ours", async () => {
  const { store, slack } = setup();
  const legacy: DailyState = { channel: "C0TESTCHAN1", ts: "999.1", date: "2026-09-27", header: "", entries: [{ label: "00:00", ok: true, marker: "", manual: false }] };
  store.seed("_status/liveone/2026-09-27.json", JSON.stringify(legacy));
  slack!.foreign.add("999.1");
  await upsertDailyRow(store, slack!, rowTarget, { day: NOW, now: NOW, entry: { label: "08:00", ok: true, marker: "", origin: "schedule" } });
  assert.deepEqual(
    slack!.calls.map((c) => c.kind),
    ["update", "post"],
  );
  assert.match(slack!.calls[1].text, /✅ 00:00 {2}· {2}✅ 08:00/, "the legacy entry carries over");
  assert.equal((store.json("_status/liveone/2026-09-27.json") as DailyState).ts, "1000.1");
});

test("row: the roster moved the client to another channel → a new row there", async () => {
  const { store } = setup();
  const before = new FakeSlack("C0OLDCHANNEL");
  await upsertDailyRow(store, before, rowTarget, { day: NOW, now: NOW, entry: { label: "00:00", ok: true, marker: "", origin: "schedule" } });
  const after = new FakeSlack("C0NEWCHANNEL");
  await upsertDailyRow(store, after, rowTarget, { day: NOW, now: NOW, entry: { label: "08:00", ok: true, marker: "", origin: "schedule" } });
  assert.deepEqual(after.calls.map((c) => c.kind), ["post"]);
  assert.equal((store.json("_status/liveone/2026-09-27.json") as DailyState).channel, "C0NEWCHANNEL");
});

test("row: a write that races another re-reads and keeps both entries", async () => {
  const { store, slack } = setup();
  await upsertDailyRow(store, slack!, rowTarget, { day: NOW, now: NOW, entry: { label: "00:00", ok: true, marker: "", origin: "schedule" } });
  const key = "_status/liveone/2026-09-27.json";
  let raced = false;
  store.beforePut = (k) => {
    if (k !== key || raced) return;
    raced = true; // someone else ticks 16:00 between our read and our write
    const s = store.json(key) as DailyState;
    s.entries.push({ label: "16:00", ok: true, marker: "", origin: "schedule" });
    store.seed(key, JSON.stringify(s));
  };
  const r = await upsertDailyRow(store, slack!, rowTarget, { day: NOW, now: NOW, entry: { label: "08:00", ok: true, marker: "", origin: "schedule" } });
  assert.equal(r.ok, true);
  const labels = (store.json(key) as DailyState).entries.map((e) => e.label).sort();
  assert.deepEqual(labels, ["00:00", "08:00", "16:00"]);
  assert.equal(slack!.posts().length, 1, "no second row");
});

test("row: a backup that finishes after midnight ticks the day it started", async () => {
  const { deps, put, store } = setup({ now: new Date("2026-09-28T00:01:00Z") });
  put(outcome({ startedAt: "2026-09-27T23:55:00.000Z", runId: "9" }));
  await notifyRun(deps, target({ runId: "9", iatMs: new Date("2026-09-28T00:01:00Z").getTime() }));
  const s = store.json("_status/liveone/2026-09-27.json") as DailyState;
  assert.equal(s.entries[0].label, "23:55");
  assert.match(s.header, /Sun 27 Sep 2026/);
});

// ── the port: identity on posts, never on updates ────────────────────────────

test("slackPortFor: posts carry the roster identity; updates can't, and don't try", async () => {
  const bodies: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, ts: "1.2" }));
  }) as typeof fetch;
  try {
    const port = slackPortFor("xoxb-test", { ...client, slack: { channel: "C0TESTCHAN1", username: "liveone backup", iconEmoji: ":zap:" } })!;
    await port.post("hi", { thread: "1.1", broadcast: true });
    await port.update("1.2", "hi again");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(bodies[0].username, "liveone backup");
  assert.equal(bodies[0].icon_emoji, ":zap:");
  assert.equal(bodies[0].thread_ts, "1.1");
  assert.equal(bodies[0].channel, "C0TESTCHAN1");
  assert.equal(bodies[1].username, undefined);
  assert.equal(bodies[1].icon_emoji, undefined);
  assert.equal(slackPortFor("", client), null, "no token → Slack off");
  assert.equal(slackPortFor("xoxb-test", { ...client, slack: undefined }), null, "no roster channel → Slack off");
});
