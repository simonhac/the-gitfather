// ─────────────────────────────────────────────────────────────────────────────
// gitfather-scheduler — a single Cloudflare Worker that replaces GitHub Actions cron, runs the
// staleness watchdog, and is the ONLY thing that posts to Slack.
//
// Two Cron Triggers, told apart by the minute they fire on:
//   */10 * * * *               the main tick. It decides which cadences are due from
//                              event.scheduledTime (the *intended* tick instant — not Date.now(), so a
//                              late delivery still maps to the slot it was meant for), fires each
//                              client's caller workflow via GitHub's REST `workflow_dispatch` API for
//                              the dispatched cadences, and runs the watchdog (watchdog.ts) natively
//                              against each client's private bucket for `staleness`.
//   5,15,25,35,45,55 * * * *   the Slack tick (slackTick): re-renders each daily row so elapsed slots
//                              show ⬜, announces any job outcome whose /notify never arrived, and
//                              checks the token. A separate invocation, so Slack work can never eat
//                              the main tick's subrequest budget.
//
// POST /notify is how a finished job says "look": authenticated by a GitHub OIDC token (oidc.ts), it
// has the Worker announce that run's outcome record (deliver.ts).
//
// The reliability guarantee: the watchdog self-heals a missed backup and pages when it can't — and it
// now lives OUTSIDE GitHub, so an Actions outage (including a billing lapse) is detected, not silenced.
// If the Worker itself dies, the external HEARTBEAT_URL dead-man's-switch pages.
//
// Auth, the roster and the GitHub calls live in github.ts; this file is scheduling, state and HTTP.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ALL_CADENCES,
  dispatchWorkflow,
  isCadence,
  safeParseClients,
  subscribes,
  workflowFor,
  type Cadence,
  type Client,
  type Env,
} from "./github.js";
import { clientSecret, readConfigs, readConfigsSettled, runWatchdogs, type ConfigRead, type WatchdogRecord } from "./watchdog.js";
import { backupDue, type BackupSchedule } from "../../scripts/lib/schedule.js";
import { OUTCOME_PREFIX } from "../../scripts/lib/jobOutcome.js";
import type { WatchdogConfig } from "../../scripts/lib/watchdogConfig.js";
import { healthVerdict, slackHealth, tickDelivered, type CronTickRecord, type SlackTickRecord } from "./health.js";
import { jobsHealth } from "./jobs.js";
import { githubPortFor } from "./github.js";
import { DEFAULT_ENGINE_REPO, GITHUB_JWKS_URL, jwksKeySource, resolveNotifyTarget, verifyGithubOidc } from "./oidc.js";
import { deliverOutcome, notifyRun, pendingOutcomes, type DeliverDeps } from "./deliver.js";
import { upsertDailyRow } from "./dailyRowStore.js";
import { displayContext } from "./outcomeRender.js";
import { authTest, isTransientSlackError, postWebhook } from "./slackApi.js";
import { slackPortFor, type SlackPort } from "./slackPort.js";
import type { ObjectStore } from "./objectStore.js";

export type { Env } from "./github.js";

type DispatchCadence = Exclude<Cadence, "staleness">;

interface DispatchResult {
  id: string;
  cadence: DispatchCadence;
  status: number; // HTTP status from GitHub; 204 = success, 0 = client not subscribed, -1 = mint/network error
  error?: string;
}

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
  // Weekly, SUNDAY 19:30 UTC. The day and hour are both load-bearing, so do not move this casually:
  //   • Sunday is when computeTiers() promotes a dump to the `weekly` tier (at the profile's
  //     anchor-hour, 16:00 UTC). Running at 19:30 puts the prune ~3.5h AFTER that promotion, so every
  //     delete is preceded by a same-day durable snapshot that lives for the weekly tier's retention.
  //     The archive is the system of record, but it is not the only copy of what was just deleted.
  //   • 19:30 is also after durableVerify (18:30), and on the half hour, so never a backup instant.
  // Opt-in per client via the roster's `cadences` (see OPT_IN_CADENCES in github.ts).
  if (t.getUTCDay() === 0 && h === 19 && m === 30) due.push("archive");
  // restoreDrill is superseded by durableVerify; dispatch it only via the manual /trigger endpoint if needed.
  return due;
}

// Only the backup caller declares a workflow_dispatch input. reason="schedule" makes runOrigin() render it
// as a clean scheduled run (no 🖐️ marker). The other callers take no inputs — extra keys → HTTP 422.
function inputsFor(cadence: DispatchCadence): Record<string, string> {
  return cadence === "backup" ? { reason: "schedule" } : {};
}

// Fire one client's caller workflow. Never throws — failures are captured so one broken client can't
// suppress the others. A 204 is success; anything else is logged with the response body.
async function dispatch(env: Env, c: Client, cadence: DispatchCadence): Promise<DispatchResult> {
  if (!subscribes(c, cadence)) return { id: c.id, cadence, status: 0 };
  const file = workflowFor(c, cadence);
  const res = await dispatchWorkflow(env, c, file, inputsFor(cadence));
  if (res.status === 204) console.log(`dispatch ok: ${c.id}/${cadence} -> ${file}`);
  else console.error(`dispatch FAIL ${res.status}: ${c.id}/${cadence} ${file} :: ${res.error ?? ""}`);
  return { id: c.id, cadence, status: res.status, ...(res.error ? { error: res.error } : {}) };
}

async function fanOut(env: Env, cadences: DispatchCadence[], clients: Client[]): Promise<DispatchResult[]> {
  // dispatch() never rejects, so Promise.all never rejects.
  return Promise.all(cadences.flatMap((cad) => clients.map((c) => dispatch(env, c, cad))));
}

/** The schedules a client's published configs declare (none → backupDue's default grid). */
function schedulesOf(read: ConfigRead | undefined): BackupSchedule[] {
  if (!read?.ok) return [];
  return read.configs.flatMap(({ cfg }) => (cfg ? [{ slotMinutes: cfg.slotMinutes, anchorHourUtc: cfg.anchorHourUtc }] : []));
}

/**
 * The clients whose backup is due at `t`, by their own published schedules. A failed config listing
 * falls back to the default grid (logged) rather than skipping: a spare backup is harmless, a missed
 * one is what the watchdog exists to catch — and it can't, with the same listing failing.
 */
async function backupClients(t: Date, clients: Client[], reads: ReadonlyMap<string, Promise<ConfigRead>>): Promise<Client[]> {
  const due = await Promise.all(
    clients.map(async (c) => {
      const read = await reads.get(c.id);
      if (read && !read.ok) console.error(`backup ${c.id}: config listing failed, using the default schedule: ${String(read.error)}`);
      return backupDue(t, schedulesOf(read));
    }),
  );
  return clients.filter((_, i) => due[i]);
}

/**
 * One tick's work: dispatch the due workflows and run the watchdog, concurrently. Each client's
 * published configs are listed ONCE and shared by the backup schedule and the watchdog. `scheduled`
 * false (the manual /trigger) dispatches `backup` to every targeted client regardless of schedule.
 */
async function runTick(
  env: Env,
  cadences: Cadence[],
  clients: Client[],
  now: Date,
  scheduled: { at: Date } | null,
): Promise<{ results: DispatchResult[]; watchdog: WatchdogRecord[] }> {
  const dispatched = cadences.filter((c): c is DispatchCadence => c !== "staleness");
  const watchdogDue = cadences.includes("staleness");
  const backupFiltered = scheduled !== null && dispatched.includes("backup");

  const reads = new Map<string, Promise<ConfigRead>>();
  for (const c of clients) {
    const needed = (watchdogDue && subscribes(c, "staleness")) || (backupFiltered && subscribes(c, "backup"));
    if (needed) reads.set(c.id, readConfigsSettled(env[c.bucket] as R2Bucket));
  }

  const dispatch$ = (async () => {
    const others = fanOut(env, dispatched.filter((c) => c !== "backup" || !backupFiltered), clients);
    const backups = backupFiltered ? fanOut(env, ["backup"], await backupClients(scheduled.at, clients, reads)) : Promise.resolve([]);
    return (await Promise.all([others, backups])).flat();
  })();
  const [results, watchdog] = await Promise.all([
    dispatch$,
    watchdogDue ? runWatchdogs(env, clients.filter((c) => subscribes(c, "staleness")), now, reads) : Promise.resolve([]),
  ]);
  return { results, watchdog };
}

/**
 * Dead-man's-switch ping. Best-effort by design: a failed ping must never fail the tick, because
 * the tick's real work (dispatching backups, running the watchdog) has already happened. A missed
 * ping costs one heartbeat interval of grace; a thrown exception here would cost a backup.
 *
 * Bounded at 5s — shorter than the backup script's 10s, because a Worker tick has far less budget
 * and this is the last thing it does.
 */
async function pingHeartbeat(url: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) console.warn(`heartbeat ping returned ${res.status}`);
  } catch (e) {
    console.warn(`heartbeat ping failed: ${String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Cron-only health record. Separate from state.json, which /trigger also writes. */
const CRON_HEALTH_KEY = "_scheduler/cron.json";

async function writeCronHealth(env: Env, rec: CronTickRecord): Promise<void> {
  await env.STATE.put(CRON_HEALTH_KEY, JSON.stringify(rec), {
    httpMetadata: { contentType: "application/json" },
  }).catch((e) => console.error(`cron.json put failed: ${String(e)}`));
}

interface TickRecord {
  tick: string;
  cadences: Cadence[];
  dispatches: { id: string; cadence: Cadence; status: number; error?: string }[];
  watchdog: WatchdogRecord[];
}

// The dashboard bucket is PUBLIC. The full r.error (a GitHub API response body) stays in the Worker console and
// the secret-gated /trigger response; the persisted record carries only a generic, status-derived code so we
// never write free-form upstream text to a public object (honours the "opaque ids only" guarantee). The
// watchdog records are outcome codes by construction (see WatchdogOutcome).
function publicErrorCode(status: number): string {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 422:
      return "unprocessable";
    case -1:
      return "mint_or_network_error";
    default:
      return "dispatch_failed";
  }
}

function toTickRecord(t: Date, cadences: Cadence[], results: DispatchResult[], watchdog: WatchdogRecord[]): TickRecord {
  return {
    tick: t.toISOString(),
    cadences,
    dispatches: results
      .filter((r) => r.status !== 0) // drop "not subscribed" no-ops
      .map((r) => ({ id: r.id, cadence: r.cadence, status: r.status, ...(r.error ? { error: publicErrorCode(r.status) } : {}) })),
    watchdog,
  };
}

// Persist scheduler state/logs to the SHARED dashboard bucket. It is public, so we record opaque ids +
// cadence + status/outcome only — never owner/repo. state.json is the latest snapshot; the per-day jsonl is
// an append-only log (R2 has no append, so read-modify-write — safe at a 10-min cadence).
async function writeState(env: Env, rec: TickRecord): Promise<void> {
  await env.STATE.put("_scheduler/state.json", JSON.stringify(rec, null, 2), {
    httpMetadata: { contentType: "application/json" },
  }).catch((e) => console.error(`state.json put failed: ${String(e)}`));

  const key = `_scheduler/log/${rec.tick.slice(0, 10)}.jsonl`; // YYYY-MM-DD
  try {
    const existing = await env.STATE.get(key);
    const prior = existing ? await existing.text() : "";
    await env.STATE.put(key, prior + JSON.stringify(rec) + "\n", {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  } catch (e) {
    console.error(`log append failed (${key}): ${String(e)}`);
  }
}

// ── Slack: /notify and the Slack tick ─────────────────────────────────────────────────────────────

/** The Slack tick runs at minute 5 of every 10 (the `5,15,25,35,45,55` trigger); the main tick at minute 0. */
const SLACK_TICK_MINUTE = 5;
const SLACK_STATE_KEY = "_scheduler/slack.json";
const AUTH_CHECK_EVERY_MS = 3600_000;
/** How far back the tick looks for unannounced outcomes — a day plus slack for a slow run. */
const RECONCILE_WINDOW_MS = 26 * 3600_000;
/** Leave a fresh record to its /notify (seconds behind it) before the tick claims it. */
const RECONCILE_GRACE_MS = 3 * 60_000;
/**
 * Announcements per Slack tick, across ALL clients: each costs ~10 subrequests against the free plan's
 * 50 per invocation, and in steady state /notify has already announced everything.
 */
const RECONCILE_MAX_PER_TICK = 2;
/** Records looked at per tick: one that turns out already announced still costs a get, and must not crowd out the rest. */
const RECONCILE_MAX_LOOKS = 6;

// GitHub's OIDC signing keys, cached for this isolate's lifetime (see jwksKeySource).
const oidcKeys = jwksKeySource(async () => {
  const res = await fetch(GITHUB_JWKS_URL, { headers: { "User-Agent": "gitfather-scheduler" } });
  if (!res.ok) throw new Error(`JWKS fetch failed ${res.status}`);
  return res.json();
});

async function publishedConfigs(store: R2Bucket): Promise<WatchdogConfig[]> {
  return (await readConfigs(store)).flatMap(({ cfg }) => (cfg ? [cfg] : []));
}

function deliverDeps(env: Env, client: Client, store: ObjectStore, configs: WatchdogConfig[], slack: SlackPort | null): DeliverDeps {
  const webhookUrl = clientSecret(env, "ALERT_WEBHOOK_URL", client.id);
  return {
    client,
    store,
    slack,
    github: githubPortFor(env, client),
    configs,
    webhook: (text) => postWebhook(webhookUrl, text),
    engineRepo: env.ENGINE_REPO || DEFAULT_ENGINE_REPO,
    now: () => new Date(),
    log: (line) => console.log(`slack ${client.id}: ${line}`),
  };
}

/**
 * POST /notify — a finished job's last step. The body is ignored: the verified token alone says which
 * client, which job and which run, and what gets posted comes from R2. 503 asks the caller's curl to
 * retry (and the Slack tick is behind it either way).
 */
async function handleNotify(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
  const audience = env.NOTIFY_AUDIENCE;
  if (!audience) return Response.json({ error: "not_configured" }, { status: 503 });
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1] ?? "";
  const v = await verifyGithubOidc(token, { audience, nowMs: Date.now(), keys: oidcKeys });
  if (!v.ok) {
    console.warn(`notify: token rejected: ${v.reason}`);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const clients = safeParseClients(env);
  if (!clients) return Response.json({ error: "not_configured" }, { status: 503 });
  const resolved = resolveNotifyTarget(v.claims, clients, env.ENGINE_REPO || DEFAULT_ENGINE_REPO);
  if (!resolved.ok) {
    console.warn(`notify: ${resolved.error} (${v.claims.repository} · ${v.claims.job_workflow_ref})`);
    return Response.json({ error: resolved.error }, { status: 403 });
  }
  const { target } = resolved;
  const { client } = target;
  const store = env[client.bucket] as R2Bucket;
  try {
    const configs = await publishedConfigs(store);
    const r = await notifyRun(deliverDeps(env, client, store, configs, slackPortFor(env.SLACK_BOT_TOKEN, client)), target);
    console.log(`notify ${client.id}: ${target.job} run ${target.runId}/${target.runAttempt} → ${r.result} (${r.count} record(s))`);
    return Response.json(r, { status: r.result === "retry" ? 503 : 200 });
  } catch (e) {
    console.error(`notify ${client.id}: ${target.job} run ${target.runId}: ${String(e)}`);
    return Response.json({ error: "internal" }, { status: 503 });
  }
}

/**
 * The Slack tick: per client, refresh each backup's daily row (⬜ for elapsed slots) and list outcome
 * records nobody has announced; then announce the oldest few. `recordHealth` is false for a manual run,
 * so hitting it by hand can't keep /health's Slack check green while the cron is gone.
 */
async function slackTick(env: Env, t: Date, opts: { recordHealth: boolean }): Promise<{ refreshed: number; announced: string[]; pending: number }> {
  const clients = safeParseClients(env);
  if (!clients) return { refreshed: 0, announced: [], pending: 0 };
  const now = new Date();
  let refreshed = 0;

  const perClient = await Promise.all(
    clients.map(async (client) => {
      const store = env[client.bucket] as R2Bucket;
      const log = (line: string) => console.log(`slack ${client.id}: ${line}`);
      try {
        const configs = await publishedConfigs(store);
        const slack = slackPortFor(env.SLACK_BOT_TOKEN, client);
        if (slack) {
          for (const cfg of configs) {
            const ctx = displayContext({ tz: cfg.timezone, slotMinutes: cfg.slotMinutes, name: cfg.name, dashboardUrl: cfg.dashboardUrl });
            const r = await upsertDailyRow(store, slack, { stateName: cfg.name, ctx }, { day: now, now, log });
            if (!r.ok) log(`[${cfg.name}] daily row refresh failed: ${r.error}`);
            else if (!r.skipped) refreshed++;
          }
        }
        const pending = await pendingOutcomes(store, { sinceMs: now.getTime() - RECONCILE_WINDOW_MS, graceMs: RECONCILE_GRACE_MS, nowMs: now.getTime() });
        return { client, store, configs, slack, pending };
      } catch (e) {
        console.error(`slack ${client.id}: tick failed: ${String(e)}`);
        return null;
      }
    }),
  );

  // Oldest first across all clients (keys start with the run's start stamp), so nothing starves.
  const queue = perClient
    .flatMap((p) => (p ? p.pending.map((key) => ({ p, key })) : []))
    .sort((a, b) => (a.key.slice(OUTCOME_PREFIX.length) < b.key.slice(OUTCOME_PREFIX.length) ? -1 : 1));
  const announced: string[] = [];
  let looked = 0;
  for (const { p, key } of queue) {
    if (announced.length >= RECONCILE_MAX_PER_TICK || looked >= RECONCILE_MAX_LOOKS) break;
    looked++;
    const r = await deliverOutcome(deliverDeps(env, p.client, p.store, p.configs, p.slack), key, { verified: false });
    console.log(`slack ${p.client.id}: reconcile ${key.slice(OUTCOME_PREFIX.length)} → ${r}`);
    if (r !== "already_posted" && r !== "claimed_elsewhere") announced.push(`${p.client.id}:${r}`);
  }
  if (queue.length > looked) console.warn(`slack: ${queue.length - looked} more unannounced outcome(s) — next tick`);

  if (opts.recordHealth) await writeSlackTick(env, t, now);
  return { refreshed, announced, pending: queue.length };
}

async function readSlackTick(env: Env): Promise<SlackTickRecord | null> {
  const obj = await env.STATE.get(SLACK_STATE_KEY).catch(() => null);
  if (!obj) return null;
  try {
    const v = JSON.parse(await obj.text()) as Partial<SlackTickRecord>;
    if (typeof v.tick !== "string") return null;
    return {
      tick: v.tick,
      authCheckedAt: typeof v.authCheckedAt === "string" ? v.authCheckedAt : null,
      authOk: typeof v.authOk === "boolean" ? v.authOk : null,
      ...(typeof v.authError === "string" ? { authError: v.authError } : {}),
    };
  } catch {
    return null; // unparseable is indistinguishable from absent
  }
}

/**
 * Record the Slack tick for /health, re-checking the token hourly (auth.test). The record lands in the
 * PUBLIC dashboard bucket, so it holds times and a Slack error code only.
 */
async function writeSlackTick(env: Env, t: Date, now: Date): Promise<void> {
  const prev = await readSlackTick(env);
  let auth: Omit<SlackTickRecord, "tick"> = {
    authCheckedAt: prev?.authCheckedAt ?? null,
    authOk: prev?.authOk ?? null,
    ...(prev?.authError ? { authError: prev.authError } : {}),
  };
  const due = !auth.authCheckedAt || now.getTime() - Date.parse(auth.authCheckedAt) >= AUTH_CHECK_EVERY_MS;
  if (env.SLACK_BOT_TOKEN && due) {
    const r = await authTest(env.SLACK_BOT_TOKEN);
    // A blip says nothing about the token — keep the previous verdict and ask again next tick.
    if (r.ok || !isTransientSlackError(r.error)) {
      auth = { authCheckedAt: now.toISOString(), authOk: r.ok, ...(r.ok ? {} : { authError: r.error }) };
      if (!r.ok) console.error(`slack: auth.test failed: ${r.error} — Slack is DOWN for every client`);
    }
  }
  const rec: SlackTickRecord = { tick: t.toISOString(), ...auth };
  await env.STATE.put(SLACK_STATE_KEY, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } }).catch((e) =>
    console.error(`slack.json put failed: ${String(e)}`),
  );
}

/** Constant-time check of the X-Trigger-Secret header (an unset secret opens nothing). */
function triggerSecretOk(req: Request, env: Env): boolean {
  const enc = new TextEncoder();
  const given = enc.encode(req.headers.get("X-Trigger-Secret") ?? "");
  const want = enc.encode(env.TRIGGER_SECRET ?? "");
  return want.length > 0 && given.length === want.length && crypto.subtle.timingSafeEqual(given, want);
}

// Manual endpoint for validating the dispatch + watchdog paths end-to-end, plus liveness/state reads.
async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    // Open liveness, but STATEFUL. It used to return a constant "ok", which is false comfort: a
    // Worker's fetch handler answers even with its Cron Trigger deleted, its ROSTER invalid, or its
    // App key revoked — green through exactly the outages worth knowing about.
    //
    // Reading the last tick also makes this INDEPENDENT of the heartbeat: the heartbeat is
    // Cloudflare→BetterStack, this is BetterStack→Cloudflare, so an uptime monitor here still fires
    // if the Worker loses outbound fetch, which would silence the heartbeat.
    // Reads the CRON-ONLY record, not state.json — /trigger overwrites state.json, so a single
    // manual trigger would otherwise refresh the whole scheduler's health and mask a dead cron.
    const obj = await env.STATE.get(CRON_HEALTH_KEY).catch(() => null);
    let last: CronTickRecord | null = null;
    if (obj) {
      try {
        const parsed = JSON.parse(await obj.text()) as Partial<CronTickRecord>;
        last = typeof parsed.tick === "string" ? { tick: parsed.tick, delivered: parsed.delivered === true } : null;
      } catch {
        last = null; // unparseable is indistinguishable from absent, and just as bad
      }
    }
    const roster = safeParseClients(env)?.length ?? 0;
    const now = new Date();
    const slack = slackHealth(await readSlackTick(env), Boolean(env.SLACK_BOT_TOKEN), now);
    const v = healthVerdict(last, roster, now, { slack });
    return Response.json(v.body, { status: v.status });
  }

  if (url.pathname === "/health/jobs") {
    // Open, like /health, and for the same reason: it is what an external uptime monitor polls. The
    // body carries only opaque client ids, job names and ages — no profile names, no bucket names.
    // A separate URL from /health because it answers a different question: /health is "is the
    // scheduler ticking", this is "did every job PROVE its claim recently" (see jobs.ts).
    const clients = safeParseClients(env);
    if (!clients) {
      return Response.json({ ok: false, checked: 0, failing: 0, checks: [], reason: "empty or invalid roster" }, { status: 503 });
    }
    const v = await jobsHealth(env, clients, new Date());
    return Response.json(v.body, { status: v.status });
  }

  // Open, like /health — but only a verified GitHub OIDC token for a rostered repo gets past it.
  if (url.pathname === "/notify") return handleNotify(req, env);

  if (!triggerSecretOk(req, env)) {
    return new Response("forbidden\n", { status: 403 });
  }

  if (url.pathname === "/slack") {
    // Run the Slack tick now (refresh rows, announce unannounced outcomes) — for validating a deploy.
    return Response.json(await slackTick(env, new Date(), { recordHealth: false }));
  }

  if (url.pathname === "/state") {
    const obj = await env.STATE.get("_scheduler/state.json");
    if (!obj) return new Response("no state yet\n", { status: 404 });
    return new Response(obj.body, { headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/trigger") {
    const cadence = url.searchParams.get("cadence");
    if (!isCadence(cadence)) {
      return new Response(`missing/invalid ?cadence (one of: ${ALL_CADENCES.join(", ")})\n`, { status: 400 });
    }
    const clients = safeParseClients(env);
    if (!clients) return new Response("ROSTER is not a valid client roster (see the Worker log)\n", { status: 500 });
    const onlyId = url.searchParams.get("client");
    const targets = clients.filter((c) => !onlyId || c.id === onlyId);
    if (targets.length === 0) return new Response("no matching client\n", { status: 404 });
    const now = new Date();
    const { results, watchdog } = await runTick(env, [cadence], targets, now, null);
    await writeState(env, toTickRecord(now, [cadence], results, watchdog));
    return Response.json({ cadence, fired: targets.map((c) => c.id), results, watchdog });
  }

  return new Response("not found\n", { status: 404 });
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const t = new Date(event.scheduledTime); // intended tick instant (UTC)
    // Keyed on the intended minute, not on event.cron's spelling, so the triggers can be written any way.
    if (t.getUTCMinutes() % 10 === SLACK_TICK_MINUTE) {
      const r = await slackTick(env, t, { recordHealth: true });
      console.log(`slack tick ${t.toISOString()} cron=${event.cron} refreshed=${r.refreshed} pending=${r.pending} announced=[${r.announced.join(",")}]`);
      return;
    }
    const cadences = dueCadences(t);
    const clients = safeParseClients(env);
    if (!clients) return; // bad roster — logged; nothing to do
    const { results, watchdog } = await runTick(env, cadences, clients, new Date(), { at: t });
    await writeState(env, toTickRecord(t, cadences, results, watchdog));
    const fired = results.filter((r) => r.status !== 0).length;
    const outcomes = watchdog.map((w) => `${w.id}${w.name ? `/${w.name}` : ""}=${w.outcome}`).join(",");
    console.log(`tick ${t.toISOString()} cron=${event.cron} cadences=[${cadences.join(",")}] dispatches=${fired} watchdog=[${outcomes}]`);

    // Ping ONLY from the cron path, never from /trigger: a manual trigger must not be able to keep
    // the heartbeat green, because debugging a dead scheduler is exactly when someone would hit
    // /trigger repeatedly and mask the very thing they are investigating. (liveone's collector
    // heartbeat carries the same `isCron` condition, for the same reason.)
    //
    // Awaited, not fire-and-forget: a Worker's `scheduled` handler may be torn down as soon as it
    // returns, which would cancel an un-awaited fetch and leave the heartbeat reading dead while
    // the scheduler is fine.
    const delivered = tickDelivered(watchdog, clients.filter((c) => subscribes(c, "staleness")).map((c) => c.id));

    // Written on EVERY cron tick, delivered or not: "ran but did not deliver" has to be visible to
    // /health, otherwise an all-`error` tick keeps it green forever while nothing is watched.
    await writeCronHealth(env, { tick: t.toISOString(), delivered });

    if (env.SCHEDULER_HEARTBEAT_URL && delivered) {
      await pingHeartbeat(env.SCHEDULER_HEARTBEAT_URL);
    } else if (!delivered) {
      console.warn(`tick ${t.toISOString()} did NOT deliver — heartbeat withheld`);
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    return handleFetch(req, env);
  },
} satisfies ExportedHandler<Env>;
