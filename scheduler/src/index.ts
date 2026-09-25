// ─────────────────────────────────────────────────────────────────────────────
// gitfather-scheduler — a single Cloudflare Worker that replaces GitHub Actions cron AND runs the
// staleness watchdog.
//
// One Cron Trigger (*/10 * * * *) wakes the Worker every 10 minutes. It decides which cadences are
// due from event.scheduledTime (the *intended* tick instant — not Date.now(), so a late delivery still
// maps to the slot it was meant for), fires each client's caller workflow via GitHub's REST
// `workflow_dispatch` API for the dispatched cadences, and runs the watchdog (watchdog.ts) natively
// against each client's private bucket for the `staleness` cadence.
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
import { runWatchdogs, type WatchdogRecord } from "./watchdog.js";
import { healthVerdict, tickDelivered, type CronTickRecord } from "./health.js";
import { jobsHealth } from "./jobs.js";

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
export function dueCadences(t: Date): Cadence[] {
  const due: Cadence[] = ["staleness"]; // every tick (the 10-min watchdog — runs natively, see watchdog.ts)
  const m = t.getUTCMinutes();
  const h = t.getUTCHours();
  if (m === 0 && h % 8 === 0) due.push("backup"); // every 8h at 00/08/16 UTC (16 = the profiles' anchor-hour → daily/weekly/monthly still promote)
  if (h === 18 && m === 30) due.push("durableVerify"); // daily ~18:30 UTC — must be after the latest anchor hour
  // Weekly, SUNDAY 19:30 UTC. The day and hour are both load-bearing, so do not move this casually:
  //   • Sunday is when computeTiers() promotes a dump to the `weekly` tier (at the profile's
  //     anchor-hour, 16:00 UTC). Running at 19:30 puts the prune ~3.5h AFTER that promotion, so every
  //     delete is preceded by a same-day durable snapshot that lives for the weekly tier's retention.
  //     The archive is the system of record, but it is not the only copy of what was just deleted.
  //   • 19:30 is also after durableVerify (18:30) and well clear of every backup hour (00/08/16).
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

/** One tick's work: dispatch the due workflows and run the watchdog, concurrently. */
async function runTick(env: Env, cadences: Cadence[], clients: Client[], now: Date): Promise<{ results: DispatchResult[]; watchdog: WatchdogRecord[] }> {
  const dispatched = cadences.filter((c): c is DispatchCadence => c !== "staleness");
  const watchdogDue = cadences.includes("staleness");
  const [results, watchdog] = await Promise.all([
    fanOut(env, dispatched, clients),
    watchdogDue ? runWatchdogs(env, clients.filter((c) => subscribes(c, "staleness")), now) : Promise.resolve([]),
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
    const v = healthVerdict(last, roster, new Date());
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

  if (req.headers.get("X-Trigger-Secret") !== env.TRIGGER_SECRET) {
    return new Response("forbidden\n", { status: 403 });
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
    const { results, watchdog } = await runTick(env, [cadence], targets, now);
    await writeState(env, toTickRecord(now, [cadence], results, watchdog));
    return Response.json({ cadence, fired: targets.map((c) => c.id), results, watchdog });
  }

  return new Response("not found\n", { status: 404 });
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const t = new Date(event.scheduledTime); // intended tick instant (UTC)
    const cadences = dueCadences(t);
    const clients = safeParseClients(env);
    if (!clients) return; // bad roster — logged; nothing to do
    const { results, watchdog } = await runTick(env, cadences, clients, new Date());
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
