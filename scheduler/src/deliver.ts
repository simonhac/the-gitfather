// ─────────────────────────────────────────────────────────────────────────────
// Announcing job outcomes in Slack — exactly once where possible, at least once always.
//
// Two paths reach an outcome record (see scripts/lib/jobOutcome.ts):
//   • POST /notify — the job's last step, seconds after the record was written (notifyRun);
//   • the Slack tick — every 10 minutes, any record nobody announced (pendingOutcomes → deliverOutcome),
//     which covers a caller that hasn't granted id-token: write, a notify that never arrived, and a
//     delivery that failed half-way.
//
// Both can see the same record, so its delivery state lives ON the record, in R2 custom metadata, and
// every transition is a compare-and-swap on its etag:
//     (none) ──claim──▶ claimed ──sent──▶ posted          (a terminal Slack error also ends in posted,
//                          │                               with gf-error, rather than retrying forever)
//                          └─ transient failure: left claimed; the 5-minute lease expires, the tick
//                             retries; after MAX_TRIES → gave_up
//     unparseable → invalid        a tick-found record whose run GitHub doesn't vouch for → rejected
// A Worker dying between posting and marking can repeat a message — a duplicate beats a lost alert.
//
// A run that wrote NO record (it died in a setup step, or before its script could start) is announced
// from the Actions API instead: /notify finds the failed step and records a synthetic outcome, which
// then goes through the same path.
//
// Deliberately free of Worker types: storage, Slack and GitHub arrive as ports, so it is testable.
// ─────────────────────────────────────────────────────────────────────────────

import {
  OUTCOME_PREFIX,
  OUTCOME_VERSION,
  isOutcomeName,
  outcomeKey,
  outcomeRunInfix,
  outcomeStartAfter,
  parseJobOutcome,
  parseOutcomeKey,
  type JobOutcome,
} from "../../scripts/lib/jobOutcome.js";
import type { WatchdogConfig } from "../../scripts/lib/watchdogConfig.js";
import { DEFAULT_BACKUPS_PER_DAY } from "../../scripts/lib/schedule.js";
import { upsertDailyRow } from "./dailyRowStore.js";
import { JSON_TYPE, listAll, type ObjectStore } from "./objectStore.js";
import { ENGINE_WORKFLOW_FILES, type NotifyTarget } from "./oidc.js";
import { jobLogUrl, renderContext, renderOutcome } from "./outcomeRender.js";
import type { Client } from "./roster.js";
import { isTransientSlackError, type SlackResult } from "./slackApi.js";
import type { SlackPort } from "./slackPort.js";

// ── GitHub, as far as delivery needs it ──────────────────────────────────────────────────────────

export interface GithubStep {
  name: string;
  conclusion: string | null;
}

export interface GithubJob {
  id: number;
  startedAt: string | null;
  steps: GithubStep[];
}

export interface GithubRun {
  createdAt: string;
  /** `path` of each reusable workflow the run called, e.g. `simonhac/the-gitfather/.github/workflows/pg-backup.yml@main`. */
  referencedWorkflows: string[];
}

/** One client's repo. Methods answer null for a 404 and THROW for anything worth retrying. */
export interface GithubPort {
  getRun(runId: string): Promise<GithubRun | null>;
  getJob(jobId: string): Promise<GithubJob | null>;
  listRunJobs(runId: string, attempt: number): Promise<GithubJob[]>;
}

// ── Delivery ─────────────────────────────────────────────────────────────────────────────────────

export interface DeliverDeps {
  client: Client;
  store: ObjectStore;
  /** null → Slack is off for this client (the webhook still fires). */
  slack: SlackPort | null;
  github: GithubPort;
  /** The bucket's published watchdog configs — each outcome renders with its backup's timezone, name and mention. */
  configs: readonly WatchdogConfig[];
  /** The client's failure webhook (a no-op when it has none). */
  webhook: (text: string) => Promise<void>;
  engineRepo: string;
  now: () => Date;
  log: (line: string) => void;
}

export type DeliveryResult =
  | "posted" // announced (or ended on a terminal Slack error, recorded as gf-error)
  | "slack_off" // no Slack for this client; the webhook (if any) fired
  | "already_posted" // an earlier delivery finished it
  | "claimed_elsewhere" // another invocation holds it right now
  | "retry" // a transient failure — the tick will try again
  | "invalid" // not a well-formed record
  | "rejected" // found by the tick, but GitHub doesn't vouch for its run
  | "gave_up" // MAX_TRIES transient failures
  | "no_outcome"; // /notify: no record, and no failed step to announce

const LEASE_MS = 5 * 60_000;
const MAX_TRIES = 3;
/** A tick-found record must belong to a run GitHub started within this window. */
const RUN_MAX_AGE_MS = 48 * 3600_000;
const FAILED_STEP = new Set(["failure", "cancelled", "timed_out"]);
const FINAL_STATES = new Set(["posted", "invalid", "rejected", "gave_up"]);

type Sent = { kind: "sent" } | { kind: "slack_off" } | { kind: "transient"; error: string } | { kind: "terminal"; error: string };

/** Render and send one outcome. Never throws for Slack failures — they come back as values. */
async function send(deps: DeliverDeps, o: JobOutcome): Promise<{ sent: Sent; webhook?: string }> {
  const cfg = deps.configs.find((c) => c.name === o.name) ?? null;
  const ctx = renderContext({
    tz: cfg?.timezone ?? "UTC",
    slotMinutes: cfg?.slotMinutes ?? 1440 / DEFAULT_BACKUPS_PER_DAY,
    name: o.name,
    dashboardUrl: cfg?.dashboardUrl ?? null,
    alertMention: cfg?.alertMention ?? null,
    logUrl: jobLogUrl(deps.client.owner, deps.client.repo, o.runId, o.jobId),
  });
  const r = renderOutcome(o, ctx);
  if (!deps.slack) return { sent: { kind: "slack_off" }, webhook: r.webhook };
  const slack = deps.slack;

  const errors: string[] = [];
  let thread = "";
  // The row needs the backup's published config (its day boundary and slot grid); without one the
  // failure still pages, just not threaded.
  if (r.row && cfg) {
    const row = await upsertDailyRow(deps.store, slack, { stateName: o.name, ctx: ctx.row }, { day: new Date(o.startedAt), now: deps.now(), entry: r.row, log: deps.log });
    if (!row.ok && row.error) errors.push(row.error);
    thread = row.ts ?? "";
  }
  const post = async (text: string | undefined, opts: { thread?: string; broadcast?: boolean } = {}): Promise<void> => {
    if (!text) return;
    const res: SlackResult = await slack.post(text, opts);
    if (!res.ok) errors.push(res.error);
  };
  await post(r.page, thread ? { thread, broadcast: true } : {});
  await post(r.warn);
  await post(r.info);

  const transient = errors.find(isTransientSlackError);
  if (transient) return { sent: { kind: "transient", error: transient } };
  if (errors.length) return { sent: { kind: "terminal", error: errors[0] }, webhook: r.webhook };
  return { sent: { kind: "sent" }, webhook: r.webhook };
}

/** Does GitHub vouch for this record's run: real, recent, and a run of the engine workflow for its job? */
async function vouch(deps: DeliverDeps, o: JobOutcome): Promise<"ok" | "reject" | "retry"> {
  let run: GithubRun | null;
  try {
    run = await deps.github.getRun(o.runId);
  } catch (e) {
    deps.log(`run ${o.runId}: GitHub lookup failed (will retry): ${String(e)}`);
    return "retry";
  }
  if (!run) return "reject";
  const age = deps.now().getTime() - Date.parse(run.createdAt);
  if (!(age >= -5 * 60_000 && age <= RUN_MAX_AGE_MS)) return "reject";
  const want = `${deps.engineRepo}/.github/workflows/${ENGINE_WORKFLOW_FILES[o.job]}@`.toLowerCase();
  return run.referencedWorkflows.some((p) => p.toLowerCase().startsWith(want)) ? "ok" : "reject";
}

/**
 * Announce the record at `key`, unless someone already has or is. `verified` = its run is already
 * vouched for (it arrived with a verified OIDC token); otherwise GitHub is asked first.
 */
export async function deliverOutcome(deps: DeliverDeps, key: string, opts: { verified: boolean }): Promise<DeliveryResult> {
  const obj = await deps.store.get(key);
  if (!obj) return "invalid";
  const meta = obj.customMetadata ?? {};
  const state = meta["gf-state"];
  if (state && FINAL_STATES.has(state)) return "already_posted";
  const nowMs = deps.now().getTime();
  if (state === "claimed" && nowMs - Date.parse(meta["gf-at"] ?? "") < LEASE_MS) return "claimed_elsewhere";
  const tries = Number(meta["gf-tries"] ?? "0") || 0;

  const body = await obj.text();
  const at = new Date(nowMs).toISOString();
  const mark = (etag: string, m: Record<string, string>) =>
    deps.store.put(key, body, { httpMetadata: JSON_TYPE, customMetadata: { "gf-at": at, ...m }, onlyIf: { etagMatches: etag } });

  const o = parseJobOutcome(body);
  const k = parseOutcomeKey(key);
  if (!o || !k || k.runId !== o.runId || k.runAttempt !== o.runAttempt || k.job !== o.job || k.name !== o.name) {
    deps.log(`outcome ${key}: not a valid record — marking invalid`);
    await mark(obj.etag, { "gf-state": "invalid" });
    return "invalid";
  }
  if (tries >= MAX_TRIES) {
    deps.log(`outcome ${key}: ${tries} failed deliveries — giving up`);
    await mark(obj.etag, { "gf-state": "gave_up" });
    return "gave_up";
  }
  if (!opts.verified) {
    const v = await vouch(deps, o);
    if (v === "retry") return "retry";
    if (v === "reject") {
      deps.log(`outcome ${key}: GitHub doesn't vouch for run ${o.runId} as a recent ${o.job} run — rejected, not posted`);
      await mark(obj.etag, { "gf-state": "rejected" });
      return "rejected";
    }
  }

  const claim = await mark(obj.etag, { "gf-state": "claimed", "gf-tries": String(tries + 1) });
  if (!claim) return "claimed_elsewhere";

  const { sent, webhook } = await send(deps, o);
  if (sent.kind === "transient") {
    deps.log(`outcome ${key}: Slack ${sent.error} — will retry (lease ${LEASE_MS / 60_000}m)`);
    return "retry";
  }
  if (webhook) await deps.webhook(webhook);
  if (sent.kind === "terminal") deps.log(`outcome ${key}: Slack refused it (${sent.error}) — not retrying`);
  const done = await mark(claim.etag, { "gf-state": "posted", ...(sent.kind === "terminal" ? { "gf-error": sent.error.slice(0, 60) } : {}) });
  if (!done) deps.log(`outcome ${key}: posted, but the posted mark was lost (it may be announced again)`);
  return sent.kind === "slack_off" ? "slack_off" : "posted";
}

/** Reduce several deliveries to one answer for /notify: any retry wins (so curl retries), else the first. */
const summarize = (rs: DeliveryResult[]): DeliveryResult => (rs.includes("retry") ? "retry" : (rs[0] ?? "no_outcome"));

/** How far back /notify looks for a run's record: longer than any job runs. */
const NOTIFY_LOOKBACK_MS = 24 * 3600_000;

/** /notify: announce the run the verified token names — its record, or failing that its failed step. */
export async function notifyRun(deps: DeliverDeps, target: NotifyTarget): Promise<{ result: DeliveryResult; count: number }> {
  const listed = await listAll(deps.store, { prefix: OUTCOME_PREFIX, startAfter: outcomeStartAfter(target.iatMs - NOTIFY_LOOKBACK_MS) });
  const infix = outcomeRunInfix(target.runId, target.runAttempt, target.job);
  const keys = listed.map((o) => o.key).filter((k) => k.includes(infix) && parseOutcomeKey(k) !== null);
  if (keys.length > 0) {
    const results: DeliveryResult[] = [];
    for (const key of keys) results.push(await deliverOutcome(deps, key, { verified: true }));
    return { result: summarize(results), count: keys.length };
  }
  return githubFallback(deps, target);
}

/** The run left no record: announce its failed step from the Actions API, through the normal path. */
async function githubFallback(deps: DeliverDeps, target: NotifyTarget): Promise<{ result: DeliveryResult; count: number }> {
  let job: GithubJob | null = null;
  try {
    if (target.jobId) job = await deps.github.getJob(target.jobId);
    if (!job) {
      const jobs = await deps.github.listRunJobs(target.runId, target.runAttempt);
      job = jobs.find((j) => j.steps.some((s) => FAILED_STEP.has(s.conclusion ?? ""))) ?? (jobs.length === 1 ? jobs[0] : null);
    }
  } catch (e) {
    deps.log(`run ${target.runId}: no outcome record, and the Actions API lookup failed (will retry): ${String(e)}`);
    return { result: "retry", count: 0 };
  }
  const failed = job?.steps.find((s) => FAILED_STEP.has(s.conclusion ?? ""));
  if (!job || !failed) {
    // A clean run that recorded nothing (e.g. a maintenance mode like archive's backfill) has nothing to say.
    deps.log(`run ${target.runId}: finished with no outcome record and no failed step — nothing to announce`);
    return { result: "no_outcome", count: 0 };
  }
  // Which backup? Unambiguous only when the bucket publishes one config; otherwise announce it under the
  // client's id (no row tick — the row belongs to a named backup).
  const only = deps.configs.length === 1 ? deps.configs[0].name : null;
  const name = only && isOutcomeName(only) ? only : isOutcomeName(deps.client.id) ? deps.client.id : "unknown";
  const now = deps.now();
  const startedAt = job.startedAt && !Number.isNaN(Date.parse(job.startedAt)) ? job.startedAt : new Date(target.iatMs).toISOString();
  const o: JobOutcome = {
    version: OUTCOME_VERSION,
    source: "github",
    job: target.job,
    name,
    runId: target.runId,
    runAttempt: target.runAttempt,
    jobId: String(job.id),
    ok: false,
    exitCode: 1,
    startedAt,
    finishedAt: now.toISOString(),
    durationMs: Math.max(0, now.getTime() - Date.parse(startedAt)),
    origin: null,
    summary: null,
    alerts: [{ severity: "page", code: "step_failed", text: `step "${failed.name}" ${failed.conclusion} before the job recorded an outcome` }],
  };
  const key = outcomeKey(o);
  // A retried notify finds the record the first attempt wrote, and delivers (or skips) that one.
  if (!(await deps.store.get(key))) await deps.store.put(key, JSON.stringify(o), { httpMetadata: JSON_TYPE });
  return { result: await deliverOutcome(deps, key, { verified: true }), count: 1 };
}

/**
 * Records under `store` that nobody has announced: no delivery state (or an expired claim), and older
 * than `graceMs` — so /notify, which normally lands seconds after the record, gets there first.
 */
export async function pendingOutcomes(store: ObjectStore, opts: { sinceMs: number; graceMs: number; nowMs: number }): Promise<string[]> {
  const listed = await listAll(store, { prefix: OUTCOME_PREFIX, startAfter: outcomeStartAfter(opts.sinceMs), include: ["customMetadata"] });
  return listed
    .filter((o) => {
      const m = o.customMetadata ?? {};
      const state = m["gf-state"];
      if (state && state !== "claimed") return false;
      if (state === "claimed" && opts.nowMs - Date.parse(m["gf-at"] ?? "") < LEASE_MS) return false;
      return opts.nowMs - o.uploaded.getTime() >= opts.graceMs && parseOutcomeKey(o.key) !== null;
    })
    .map((o) => o.key);
}
