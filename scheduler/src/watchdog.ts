// ─────────────────────────────────────────────────────────────────────────────
// The staleness watchdog, run natively in the Worker every 10-minute tick — asserts a fresh backup
// has LANDED (an object, not a green run), self-heals a missed slot by dispatching the client's
// backup workflow, and keeps the Slack status row honest. Formerly the-gitfather's
// scripts/check-staleness.ts, dispatched to GitHub Actions each tick; it now runs here so that
// (a) it costs no Actions minutes and (b) an Actions outage — including the private org's billing
// lapsing — is DETECTED by this watchdog instead of silencing it.
//
// Per client bucket, one check per published `_config/<name>/watchdog.json` (written by the backup
// job from its validated profile — see scripts/lib/watchdogConfig.ts; config flows GitHub →
// Cloudflare, never the reverse). The decision logic is shared source with the Actions-side scripts
// (schedule.ts, alertDecision.ts, dailyRow.ts, runlogParse.ts, slackApi.ts), so the two runtimes
// cannot drift on what "overdue", "broken" or a ⬜ mean.
//
// Freshness is slot-based: if the CURRENT cadence slot (slotMinutes) still has no backup once
// graceMinutes past its boundary, the slot is overdue — a missed tick is caught ~grace minutes later,
// not after the multi-hour maxAgeHours backstop. The default assumption is a *missed* dispatch and it
// re-triggers the backup once — but only when the backup isn't persistently failing (a *broken* backup
// is paged, not retried, to avoid a trigger loop). Never throws: every outcome is a code.
// ─────────────────────────────────────────────────────────────────────────────

import { advanceAlertState, alertStateKey, decideAlert, parseAlertState, type AlertState } from "../../scripts/lib/alertDecision.js";
import { formatElapsed } from "../../scripts/lib/duration.js";
import { backupLooksBroken, slotState, stampToEpochMs } from "../../scripts/lib/schedule.js";
import { pickLatestRun, runlogKey, runlogMonthsToTry } from "../../scripts/lib/runlogParse.js";
import { postMessage, postWebhook, updateMessage } from "../../scripts/lib/slackApi.js";
import {
  dailyHeaderIn,
  dailyStateKey,
  dateKeyIn,
  failAlertTextIn,
  parseDailyState,
  renderDailyTextIn,
  type RowContext,
} from "../../scripts/lib/dailyRow.js";
import { parseWatchdogConfig, WATCHDOG_CONFIG_PREFIX, type WatchdogConfig } from "../../scripts/lib/watchdogConfig.js";
import { dispatchWorkflow, listWorkflowRuns, type Client, type Env } from "./github.js";

// Outcome codes live in health.ts so that module can stay free of Worker types (it is imported by
// the Node-typed test side). Imported for use here, and re-exported so every existing
// `from "./watchdog.js"` import elsewhere keeps working.
import type { WatchdogOutcome, WatchdogRecord } from "./health.js";
export type { WatchdogOutcome, WatchdogRecord };

/** A client-scoped secret: `<NAME>_<ID>` (id upper-cased, non-alphanumerics → `_`) falling back to `<NAME>`. */
export function clientSecret(env: Env, name: string, clientId: string): string {
  const scoped = env[`${name}_${clientId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  const shared = env[name];
  return typeof scoped === "string" && scoped ? scoped : typeof shared === "string" ? shared : "";
}

/** Read an object as text; null when absent. Throws on a real R2 error (callers decide the failure direction). */
async function getText(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);
  return obj ? obj.text() : null;
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

/** Every published watchdog config in a bucket (one per backup name). */
async function readConfigs(bucket: R2Bucket): Promise<{ key: string; cfg: WatchdogConfig | null }[]> {
  const listed = await bucket.list({ prefix: WATCHDOG_CONFIG_PREFIX });
  const keys = listed.objects.map((o) => o.key).filter((k) => k.endsWith("/watchdog.json"));
  return Promise.all(keys.map(async (key) => ({ key, cfg: parseWatchdogConfig((await getText(bucket, key)) ?? "") })));
}

interface Check {
  env: Env;
  client: Client;
  bucket: R2Bucket;
  cfg: WatchdogConfig;
  now: Date;
  slackToken: string;
  webhookUrl: string;
  ctx: RowContext;
  log: (line: string) => void;
}

const slackOn = (c: Check): boolean => Boolean(c.slackToken && c.cfg.slackChannel);

/** Quiet post (no mention) — self-heal progress. Best-effort. */
async function note(c: Check, text: string): Promise<void> {
  c.log(text);
  if (slackOn(c)) await postMessage(c.slackToken, c.cfg.slackChannel!, text, { onError: (e) => c.log(`slack: chat.postMessage failed: ${e}`) });
}

/**
 * Page on ENTRY to an outage, on any change of cause, and then only once per repageMinutes — the
 * throttle governs Slack only; the tick's outcome is recorded regardless. `cause` is the classified
 * failure code from the run-log (null when unknown). Any problem reading the episode state resolves
 * to PAGE, because a missing page is the one failure mode we can't accept.
 */
async function fail(c: Check, msg: string, cause: string | null = null): Promise<void> {
  c.log(`ERROR: ${msg}`);
  const nowMs = c.now.getTime();
  const key = alertStateKey(c.cfg.name);
  let prev: AlertState | null = null;
  try {
    prev = parseAlertState((await getText(c.bucket, key)) ?? "");
  } catch (e) {
    c.log(`alert-state read failed (paging): ${String(e)}`);
  }
  const decision = decideAlert(prev, nowMs, cause, c.cfg.repageMinutes);
  if (decision.page) {
    if (slackOn(c)) {
      await postMessage(c.slackToken, c.cfg.slackChannel!, `${c.cfg.alertMention} ${failAlertTextIn("STALE", msg, "", c.ctx)}`, {
        onError: (e) => c.log(`slack: chat.postMessage failed: ${e}`),
      });
    }
    await postWebhook(c.webhookUrl, `🔴 PG backup STALE (${c.cfg.name}): ${msg}`);
  } else {
    c.log(`(alert throttled: already paged for this outage; next page in ~${decision.nextPageInMinutes}m — repageMinutes=${c.cfg.repageMinutes})`);
  }
  await putJson(c.bucket, key, advanceAlertState(prev, nowMs, cause, decision)).catch((e) => c.log(`alert-state write failed: ${String(e)}`));
}

/**
 * Re-render today's Slack row in place (no new tick) so elapsed-but-empty slots surface as ⬜.
 * No-op when today has no message yet, when Slack is off, or when the state can't be read — a split
 * row misleads and a missing refresh is benign. Best-effort.
 */
async function refreshDailyRow(c: Check): Promise<void> {
  if (!slackOn(c)) return;
  const key = dailyStateKey(c.cfg.name, dateKeyIn(c.now, c.ctx.tz));
  let raw: string | null;
  try {
    raw = await getText(c.bucket, key);
  } catch (e) {
    c.log(`daily-row read failed (skipping refresh): ${String(e)}`);
    return;
  }
  if (!raw) return; // no message today yet — the backup creates it
  const state = parseDailyState(raw);
  if (!state || !state.ts) return;
  state.header = dailyHeaderIn(c.now, c.ctx); // recomputed each persist so a config change relinks in place
  const ok = await updateMessage(c.slackToken, c.cfg.slackChannel!, state.ts, renderDailyTextIn(state, c.now, c.ctx), {
    onError: (e) => c.log(`slack: chat.update failed: ${e}`),
  });
  if (ok) await putJson(c.bucket, key, state).catch((e) => c.log(`daily-row write failed: ${String(e)}`));
}

/** The classified cause + human reason of the latest run, from the private run-log. Best-effort. */
async function latestRunCause(c: Check): Promise<{ cause: string | null; because: string }> {
  for (const ym of runlogMonthsToTry(c.now)) {
    let body: string | null;
    try {
      body = await getText(c.bucket, runlogKey(c.cfg.name, ym));
    } catch {
      continue;
    }
    if (!body) continue;
    const latest = pickLatestRun(body);
    if (!latest) continue;
    if (latest.ok === false) {
      return { cause: latest.errorCode ?? null, because: latest.error ? ` — ${latest.error}` : "" };
    }
    return { cause: null, because: "" };
  }
  return { cause: null, because: "" };
}

/**
 * Handle a stale newest backup. Default assumption: a dispatch was MISSED → self-heal by re-triggering
 * the backup. The one thing we must NOT do is hammer a *persistently* BROKEN backup. In order:
 *   1. selfHeal off → can't self-heal, page loudly.
 *   2. a backup already queued/running → let it finish, don't pile up.
 *   3. the two most recent COMPLETED runs both failed → broken, not missed → page loudly, do NOT retry.
 *   4. otherwise → trigger ONE catch-up backup (reason=self-heal → 🩹), quiet note.
 */
async function onStale(c: Check, msg: string): Promise<WatchdogOutcome> {
  c.log(`STALE: ${msg}`);
  if (!c.cfg.selfHeal) {
    await fail(c, msg);
    return "stale-no-heal";
  }

  // One query feeds both checks: recent runs with status (in-flight) + conclusion (broken vs missed).
  // A failed listing reads as [] — none in-flight, retry-eligible — like the old `gh` path.
  const runs = await listWorkflowRuns(c.env, c.client, c.cfg.healWorkflow).catch((e) => {
    c.log(`run listing failed (treating as none): ${String(e)}`);
    return [];
  });

  const inflight = runs.filter((r) => r.status === "in_progress" || r.status === "queued").length;
  if (inflight !== 0) {
    await note(c, `🟡 PG backup STALE (${c.cfg.name}): ${msg} — a backup is already running; waiting it out.`);
    return "stale-inflight";
  }

  if (backupLooksBroken(runs)) {
    const failed = runs.find((r) => r.status === "completed")?.conclusion || "failure";
    // GitHub only knows the run failed. The run-log knows WHY — quote it, so the page an operator reads
    // says "the credential is stale" rather than sending them to the Actions log to find out.
    const { cause, because } = await latestRunCause(c);
    await fail(c, `${msg} — backup failing repeatedly (latest \`${failed}\`)${because}; not auto-retrying (broken, not missed).`, cause);
    return "stale-broken";
  }
  const last = runs.find((r) => r.status === "completed")?.conclusion || "";

  if (c.cfg.dryRun) {
    await note(c, `🟡 [dry-run] PG backup STALE (${c.cfg.name}): ${msg} — would trigger a catch-up backup (last run \`${last || "none"}\`).`);
    return "stale-dry-run";
  }

  // Tag the catch-up as a self-heal so the Slack row shows 🩹 (not 🖐️). Tolerant of a caller that hasn't
  // declared the `reason` input (HTTP 422 "Unexpected inputs"): retry once without — marked 🖐️ instead.
  let res = await dispatchWorkflow(c.env, c.client, c.cfg.healWorkflow, { reason: "self-heal" });
  if (res.status === 422) {
    c.log(`dispatch with reason=self-heal was rejected (422); retrying without inputs — catch-up will show 🖐️, not 🩹`);
    res = await dispatchWorkflow(c.env, c.client, c.cfg.healWorkflow, {});
  }
  if (res.status === 204) {
    await note(c, `🟡 PG backup STALE (${c.cfg.name}): ${msg} — triggered a catch-up backup (last run \`${last || "none"}\`). Will page if it doesn't recover.`);
    return "stale-healed";
  }
  await fail(c, `${msg} — and the catch-up trigger (${c.cfg.healWorkflow}, HTTP ${res.status}) failed.`);
  return "stale-unhealed";
}

/** One backup's check. Everything after config parsing is inside; throws only on an R2 listing failure. */
async function checkOne(c: Check): Promise<WatchdogOutcome> {
  const { cfg, now } = c;

  // Newest object under <prefix>/2hourly/ — key order is lexical = chronological (stamped names).
  const prefix = `${cfg.backupPrefix}/2hourly/`;
  const listed = await c.bucket.list({ prefix });
  const objects = listed.objects.filter((o) => o.key.length > prefix.length).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const newestObj = objects.length ? objects[objects.length - 1] : null;
  if (!newestObj) {
    await fail(c, `no objects under ${prefix}`);
    return "no-objects";
  }
  const newest = newestObj.key.slice(prefix.length);

  // Size gate: a fresh-but-truncated/empty object is BROKEN, not a missed tick — page directly (never
  // self-heal, which would just re-trigger a backup that may keep producing a bad object).
  if (newestObj.size < cfg.minBytes) {
    await fail(c, `newest object ${newest} is ${newestObj.size} bytes (< dump.min-bytes ${cfg.minBytes}) — truncated/empty, not just stale`);
    return "broken-size";
  }

  // Filename: <name>-YYYYMMDDTHHMMSSZ.<ext> → the stamp, always UTC.
  const namePrefix = `${cfg.name}-`;
  const stamp = (newest.startsWith(namePrefix) ? newest.slice(namePrefix.length) : newest).split(".")[0];
  const epochMs = stamp.length >= 16 ? stampToEpochMs(stamp) : NaN;
  if (Number.isNaN(epochMs)) {
    await fail(c, `cannot interpret timestamp '${stamp}' from '${newest}'`);
    return "bad-stamp";
  }

  const nowMs = now.getTime();
  const ageH = Math.floor((nowMs - epochMs) / 3_600_000);
  const ageM = Math.floor((nowMs - epochMs) / 60_000);
  const ageText = formatElapsed(nowMs - epochMs);

  // Refresh today's Slack row every tick (independent of freshness): re-renders ⬜ placeholders.
  await refreshDailyRow(c);

  const { overdue, slotStartMs } = slotState(nowMs, epochMs, cfg.slotMinutes, cfg.graceMinutes);
  const slotIso = new Date(slotStartMs).toISOString();
  c.log(`newest 2hourly object: ${newest} — ${ageText} old (slot ${slotIso}, grace ${cfg.graceMinutes}m, backstop ${cfg.maxAgeHours}h)`);

  if (!overdue && ageH < cfg.maxAgeHours) {
    // Close the loop: an outage that ends should SAY so. Any problem reading the episode reads as "none".
    const key = alertStateKey(cfg.name);
    const prev = parseAlertState((await getText(c.bucket, key).catch(() => null)) ?? "");
    if (prev) {
      const downFor = formatElapsed(nowMs - Date.parse(prev.since));
      await note(c, `🟢 PG backup RECOVERED (${cfg.name}): ${newest} landed — stale for ${downFor}.`);
      await c.bucket.delete(key).catch((e) => c.log(`alert-state delete failed: ${String(e)}`));
      return "recovered";
    }
    c.log(`✓ fresh: newest backup is ${ageText} old; current slot (${slotIso}) satisfied`);
    return "fresh";
  }
  return onStale(
    c,
    overdue
      ? `slot ${slotIso} backup is overdue (>${cfg.graceMinutes}m past the boundary; newest ${newest} is ${ageM}m old)`
      : `newest backup ${newest} is ${ageH}h old (> ${cfg.maxAgeHours}h backstop)`,
  );
}

/** Run the watchdog for one client: every published config in its bucket. Never throws. */
export async function runWatchdog(env: Env, client: Client, now: Date): Promise<WatchdogRecord[]> {
  const log = (line: string) => console.log(`watchdog ${client.id}: ${line}`);
  const bucket = env[client.bucket] as R2Bucket;
  let configs: { key: string; cfg: WatchdogConfig | null }[];
  try {
    configs = await readConfigs(bucket);
  } catch (e) {
    console.error(`watchdog ${client.id}: config listing failed: ${String(e)}`);
    return [{ id: client.id, name: "", outcome: "error" }];
  }
  if (configs.length === 0) {
    console.warn(`watchdog ${client.id}: no ${WATCHDOG_CONFIG_PREFIX}*/watchdog.json in the bucket yet — run the backup once to publish it`);
    return [{ id: client.id, name: "", outcome: "no-config" }];
  }
  return Promise.all(
    configs.map(async ({ key, cfg }): Promise<WatchdogRecord> => {
      if (!cfg) {
        console.error(`watchdog ${client.id}: ${key} is not a valid watchdog config — skipping`);
        return { id: client.id, name: "", outcome: "no-config" };
      }
      const c: Check = {
        env,
        client,
        bucket,
        cfg,
        now,
        slackToken: clientSecret(env, "SLACK_BOT_TOKEN", client.id),
        webhookUrl: clientSecret(env, "ALERT_WEBHOOK_URL", client.id),
        ctx: { tz: cfg.timezone, slotMinutes: cfg.slotMinutes, name: cfg.name, dashboardUrl: cfg.dashboardUrl ?? "" },
        log: (line) => log(`[${cfg.name}] ${line}`),
      };
      try {
        return { id: client.id, name: cfg.name, outcome: await checkOne(c) };
      } catch (e) {
        console.error(`watchdog ${client.id}: [${cfg.name}] unexpected error: ${String(e)}`);
        return { id: client.id, name: cfg.name, outcome: "error" };
      }
    }),
  );
}

/** All clients that subscribe to the watchdog, concurrently; one client's failure never touches another. */
export async function runWatchdogs(env: Env, clients: Client[], now: Date): Promise<WatchdogRecord[]> {
  const records = await Promise.all(clients.map((c) => runWatchdog(env, c, now)));
  return records.flat();
}
