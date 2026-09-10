// ─────────────────────────────────────────────────────────────────────────────
// Slack helpers for the backup tool — the Actions-side binding of two pure modules:
//
//   slackApi.ts  — the Web API calls (chat.postMessage / chat.update / a failure webhook)
//   dailyRow.ts  — the daily status row: keys, header, ⬜ placeholder maths, rendering
//
// This file adds what only the Actions side has: the profile (token, channel, name, mention,
// dashboard url), the module-load DISPLAY_TZ / SLOT_MINUTES constants, and rclone for the
// _status/<basename>/<date>.json state. The Cloudflare Worker's watchdog binds the same two modules
// to its secrets + the published watchdog config and its R2 binding instead — one renderer, two
// runtimes, so a row the backup wrote and a row the watchdog refreshed can never disagree.
//
// All helpers are best-effort: if the bot token or channel are missing they no-op, and Slack
// failures never throw to the caller.
//
// Reads (all via the tolerant peekProfile(), so a config-failure path can still post):
//   credentials.slackToken (SLACK_BOT_TOKEN, env)     unset → Slack disabled
//   slack.channel / credentials.slackChannel (SLACK_CHANNEL, env — wins when set)   channel id (C…)
//   slack.alertMention     mention prepended to loud alerts (profile; default "<!here>")
//   name                   names the per-day state object and the message header (profile)
//   dashboard.url          if set, hyperlinks the daily header's "<name> DB backup" to the dashboard
//   credentials.alertWebhookUrl (ALERT_WEBHOOK_URL, env)   optional generic failure webhook
//   credentials.r2.bucket (R2_BUCKET, env) + the RCLONE_CONFIG_R2_* exports set by the caller
//   DISPLAY_TZ / SLOT_MINUTES   read at module load (bridged from the profile by bootEnv)
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./proc.js";
import { peekProfile, resolvedSlackChannel } from "./config.js";
import { DISPLAY_TZ, SLOT_MINUTES } from "./backupTypes.js";
import type { RunOrigin } from "./backupTypes.js";
import { postMessage, updateMessage, postWebhook } from "./slackApi.js";
import {
  dailyLabelIn,
  dailyHeaderIn,
  dailyStateKey,
  dateKeyIn,
  failAlertTextIn,
  link,
  parseDailyState,
  renderDailyTextIn,
  type DailyState,
  type RowContext,
} from "./dailyRow.js";

export { link };
export type { DailyEntry, DailyState } from "./dailyRow.js";

function warn(msg: string): void {
  process.stderr.write(`slack: ${msg}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// All reads go through peekProfile() (tolerant — never exits) so a Slack ❌ can still post even when a
// task-level config error has been detected. Credentials live under .credentials; config under the groups.
const slackToken = (): string => peekProfile()?.credentials.slackToken ?? "";
const slackChannel = (): string => {
  const p = peekProfile();
  return p ? resolvedSlackChannel(p) : "";
};
const fileBasename = (): string => peekProfile()?.name ?? "";

/** The row context for this process: the profile's zone/cadence/name/url. */
const rowContext = (): RowContext => ({
  tz: DISPLAY_TZ,
  slotMinutes: SLOT_MINUTES,
  name: fileBasename(),
  dashboardUrl: peekProfile()?.dashboard.url ?? "",
});

/** Slack is enabled iff a bot token and a channel are configured. */
export function slackEnabled(): boolean {
  return Boolean(slackToken()) && Boolean(slackChannel());
}

// ── Slack Web API (fetch, never throws) ──────────────────────────────────────

/** Post a message; returns the new message ts ("" if disabled or failed). */
export async function slackPost(
  text: string,
  opts: { thread?: string; broadcast?: boolean } = {},
): Promise<string> {
  if (!slackEnabled()) return "";
  return postMessage(slackToken(), slackChannel(), text, {
    ...opts,
    onError: (e) => warn(`chat.postMessage failed: ${e}`),
  });
}

/** Update a message in place. */
export async function slackUpdate(ts: string, text: string): Promise<void> {
  if (!slackEnabled()) return;
  await updateMessage(slackToken(), slackChannel(), ts, text, { onError: (e) => warn(`chat.update failed: ${e}`) });
}

/** One-off post (drill / verify); `mention` prepends the alert mention. */
export async function slackOneoff(text: string, mention = false): Promise<void> {
  if (!slackEnabled()) return;
  const body = mention ? `${peekProfile()?.slack.alertMention || "<!here>"} ${text}` : text;
  await slackPost(body);
}

/**
 * Optional generic failure webhook, INDEPENDENT of the bot. POSTs a Slack-compatible {"text":…} to
 * ALERT_WEBHOOK_URL: a no-bot alert fallback, or a redundant failure channel into a host app's existing
 * incoming webhook when the bot is also configured. Callers fire it on FAILURE only. No-op when unset.
 */
export async function alertWebhook(text: string): Promise<void> {
  await postWebhook(peekProfile()?.credentials.alertWebhookUrl ?? "", text);
}

// ── R2 helpers for the daily-row state ───────────────────────────────────────

/** rclone with up to 3 attempts and 2s/4s backoff — distinguishes "R2 unreachable" (all
 * attempts fail) from "object genuinely absent" (a successful but empty listing). */
async function rcloneTry(args: string[]): Promise<{ ok: boolean; out: string }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = capture("rclone", args);
    if (r.ok) return r;
    if (attempt < 3) await sleep(attempt * 2000);
  }
  return { ok: false, out: "" };
}

// ── Daily status row ─────────────────────────────────────────────────────────

/** Current HH:MM in DISPLAY_TZ — the tick label (was `TZ=$DISPLAY_TZ date +%H:%M`). */
export function dailyLabel(now: Date = new Date()): string {
  return dailyLabelIn(now, DISPLAY_TZ);
}

/** Wrap `text` in a Slack mrkdwn link to the dashboard URL when set; otherwise return it unchanged. */
export function dashboardLink(text: string): string {
  return link(peekProfile()?.dashboard.url ?? "", text);
}

/**
 * Body of a loud failure alert (MENTION-FREE — callers add the mention: slackOneoff(…, true) prepends
 * it; the backup prepends it inline then threads, so baking it in here would double-mention).
 *   🔴 *<name> DB backup* <what> — <reason>
 */
export function failAlertText(what: string, reason: string, logUrl = ""): string {
  return failAlertTextIn(what, reason, logUrl, rowContext());
}

/** The day-message header for `now` in DISPLAY_TZ, recomputed from current config on every persist. */
export function dailyHeader(now: Date = new Date()): string {
  return dailyHeaderIn(now, rowContext());
}

/** Render the message text (pure — `now` drives which buckets are "due"). */
export function renderDailyText(state: DailyState, now: Date = new Date()): string {
  return renderDailyTextIn(state, now, rowContext());
}

/**
 * Load today's state JSON. Returns null (caller should SKIP) when R2 is unreachable or the
 * state is unreadable; returns a fresh state for a genuinely-absent day. A directory listing
 * gives a clean exists/absent signal; when in doubt, skip — a split row misleads and a
 * missing tick is benign.
 */
async function loadDaily(now: Date = new Date()): Promise<DailyState | null> {
  const bucket = peekProfile()?.credentials.r2.bucket ?? "";
  const basename = fileBasename();
  const dateKey = dateKeyIn(now, DISPLAY_TZ);
  const objKey = dailyStateKey(basename, dateKey);

  const listing = await rcloneTry(["lsf", "--files-only", `r2:${bucket}/_status/${basename}/`, "--s3-no-check-bucket"]);
  if (!listing.ok) {
    warn("cannot reach R2 to check today's Slack message — skipping Slack update this run");
    return null;
  }

  const present = listing.out
    .split("\n")
    .map((s) => s.trim())
    .includes(`${dateKey}.json`);
  if (!present) {
    return { channel: "", ts: "", date: dateKey, header: dailyHeader(now), entries: [] };
  }

  const cat = await rcloneTry(["cat", `r2:${bucket}/${objKey}`, "--s3-no-check-bucket"]);
  if (!cat.ok) {
    warn("today's Slack state exists but is unreadable — skipping Slack update this run");
    return null;
  }
  if (!cat.out) {
    warn("today's Slack state is present but empty — skipping Slack update this run");
    return null;
  }
  const state = parseDailyState(cat.out);
  if (!state) warn("today's Slack state is unparseable JSON — skipping Slack update this run");
  return state;
}

/**
 * Render + post (create) or update (existing) the day's message, then save state back to R2.
 * In "refresh" mode with no existing message, stays quiet (no all-empty row). Returns the
 * message ts. Persists via a temp file + copyto (a sized PUT) rather than rcat — R2 rejects
 * the streaming-signature upload rcat issues.
 */
async function persistDaily(state: DailyState, mode: "create" | "refresh", now: Date = new Date()): Promise<string> {
  if (!state.ts && mode === "refresh") return "";
  // Recompute the header from current config each persist so config changes (e.g. adding
  // dashboard.url) and manual runs relink the existing day's message in place.
  state.header = dailyHeader(now);
  const text = renderDailyText(state, now);
  if (!state.ts) {
    const ts = await slackPost(text);
    if (!ts) {
      warn("could not post daily slack message");
      return "";
    }
    state.ts = ts;
    state.channel = slackChannel();
  } else {
    await slackUpdate(state.ts, text);
  }

  const objKey = dailyStateKey(fileBasename(), dateKeyIn(now, DISPLAY_TZ));
  const stateFile = join(tmpdir(), `slack-state-${process.pid}-${state.date}.json`);
  writeFileSync(stateFile, JSON.stringify(state));
  const bucket = peekProfile()?.credentials.r2.bucket ?? "";
  const put = capture("rclone", ["copyto", stateFile, `r2:${bucket}/${objKey}`, "--s3-no-check-bucket"]);
  if (!put.ok) warn("could not save slack daily state to R2");
  try {
    unlinkSync(stateFile);
  } catch {
    /* temp cleanup is best-effort */
  }
  return state.ts;
}

/**
 * Record a ✅/❌ tick on today's message (posting it if absent) and return the day-message ts
 * (for threading a failure alert). `origin` tags the tick: "manual" → 🖐️, "self-heal" → 🩹,
 * "schedule" → no marker.
 */
export async function slackDailyRecord(
  ok: boolean,
  label: string,
  marker = "",
  origin: RunOrigin = "schedule",
  now: Date = new Date(),
): Promise<string> {
  if (!slackEnabled()) return "";
  const state = await loadDaily(now);
  if (!state) return "";
  // Write BOTH `origin` (new renderer) and `manual` (legacy renderer) so an old instance running
  // mid-cutover still renders 🖐️ for a non-scheduled run.
  state.entries = state.entries
    .filter((e) => e.label !== label)
    .concat([{ label, ok, marker, origin, manual: origin !== "schedule" }]);
  return persistDaily(state, "create", now);
}

/**
 * Re-render today's message in place (no new tick) so elapsed-but-empty buckets surface as
 * ⬜. No-op if today has no message yet. The Worker's watchdog does this every 10 minutes; this
 * Actions-side twin remains for local use.
 */
export async function slackDailyRefresh(now: Date = new Date()): Promise<void> {
  if (!slackEnabled()) return;
  const state = await loadDaily(now);
  if (!state) return;
  await persistDaily(state, "refresh", now);
}
