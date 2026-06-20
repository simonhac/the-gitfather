// ─────────────────────────────────────────────────────────────────────────────
// Slack helpers for the backup tool — standalone (Node global fetch + rclone).
//
// Talks to the Slack Web API directly with the tool's OWN bot token (chat.postMessage /
// chat.update) — deliberately not coupled to any host app's Slack infra, so this stays
// portable. Imported by the backup / drill / staleness scripts. All helpers are
// best-effort: if the bot token or channel are missing they no-op, and Slack failures
// never throw to the caller.
//
// Port of lib/slack.sh: curl → fetch (AbortController, 15s), jq → native JSON. The
// daily-row bucket math now SHARES SLOTS_PER_DAY + the Intl TZ helper (tzParts) with the
// dashboard (backupTypes.ts / backupHistory.ts) instead of re-deriving slot=floor(hour/2)
// and `TZ=date` in bash — deleting the duplication the old slack.sh warned had to be kept
// in sync. The persisted _status/<basename>/<date>.json schema is unchanged
// ({channel,ts,date,header,entries:[{label,ok,marker,manual}]}) so a same-day cutover
// reads existing state and updates in place rather than double-posting.
//
// Reads from the environment / profile:
//   SLACK_BOT_TOKEN      xoxb-… (scope chat:write); unset → Slack disabled
//   SLACK_CHANNEL        channel id (C…) to post in
//   SLACK_ALERT_MENTION  mention prepended to loud alerts (default "<!here>")
//   DISPLAY_TZ           IANA tz for the daily row's date + HH:MM labels (default UTC)
//   FILE_BASENAME        names the per-day state object and the message header
//   DASHBOARD_URL        if set, hyperlinks the daily header's "<basename> DB backup" to the dashboard
//   R2_BUCKET + the RCLONE_CONFIG_R2_* exports set by the caller (for the daily-row state in R2)
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./proc.js";
import { DISPLAY_TZ, SLOTS_PER_DAY } from "./backupTypes.js";
import { tzParts } from "./backupHistory.js";

function warn(msg: string): void {
  process.stderr.write(`slack: ${msg}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function env(name: string): string {
  return process.env[name] ?? "";
}

/** Slack is enabled iff a bot token and a channel are configured. */
export function slackEnabled(): boolean {
  return Boolean(env("SLACK_BOT_TOKEN")) && Boolean(env("SLACK_CHANNEL"));
}

// ── Slack Web API (fetch, never throws) ──────────────────────────────────────

interface SlackApiResult {
  ok: boolean;
  body: Record<string, unknown>;
}

async function slackApi(method: string, payload: Record<string, unknown>): Promise<SlackApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000); // hard 15s, mirrors curl -m 15
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("SLACK_BOT_TOKEN")}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: body.ok === true, body };
  } catch {
    return { ok: false, body: {} };
  } finally {
    clearTimeout(timer);
  }
}

/** Post a message; returns the new message ts ("" if disabled or failed). */
export async function slackPost(
  text: string,
  opts: { thread?: string; broadcast?: boolean } = {},
): Promise<string> {
  if (!slackEnabled()) return "";
  const payload: Record<string, unknown> = {
    channel: env("SLACK_CHANNEL"),
    text,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (opts.thread) {
    payload.thread_ts = opts.thread;
    payload.reply_broadcast = opts.broadcast ?? false;
  }
  const resp = await slackApi("chat.postMessage", payload);
  if (!resp.ok) {
    warn(`chat.postMessage failed: ${String(resp.body.error ?? "?")}`);
    return "";
  }
  return typeof resp.body.ts === "string" ? resp.body.ts : "";
}

/** Update a message in place. */
export async function slackUpdate(ts: string, text: string): Promise<void> {
  if (!slackEnabled()) return;
  const resp = await slackApi("chat.update", {
    channel: env("SLACK_CHANNEL"),
    ts,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!resp.ok) warn(`chat.update failed: ${String(resp.body.error ?? "?")}`);
}

/** One-off post (drill / staleness); `mention` prepends the alert mention. */
export async function slackOneoff(text: string, mention = false): Promise<void> {
  if (!slackEnabled()) return;
  const body = mention ? `${env("SLACK_ALERT_MENTION") || "<!here>"} ${text}` : text;
  await slackPost(body);
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
// One Slack message per DISPLAY_TZ day, persisted as _status/<basename>/<date>.json in R2
// and updated in place. Each 2-hourly run records a ✅/❌ + HH:MM tick; the renderer also
// injects a ⬜ placeholder for every *elapsed but empty* 2-hourly bucket (SLOTS_PER_DAY
// buckets/day, slot = floor(hour/2) — shared with the dashboard heatmap).

export interface DailyEntry {
  label: string;
  ok: boolean;
  marker: string;
  manual: boolean;
}

export interface DailyState {
  channel: string;
  ts: string;
  date: string;
  header: string;
  entries: DailyEntry[];
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

const hmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// C-locale-style abbreviations (en-US gives "Sep"/"Mon", matching bash `date +%b`/`%a`).
const headerDateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const tzAbbrFmt = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, timeZoneName: "short" });

/** Current HH:MM in DISPLAY_TZ — the tick label (was `TZ=$DISPLAY_TZ date +%H:%M`). */
export function dailyLabel(now: Date = new Date()): string {
  const parts = hmFmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  let hh = get("hour");
  if (hh === "24") hh = "00";
  return `${hh}:${get("minute")}`;
}

/** Wrap `text` in a Slack mrkdwn link to DASHBOARD_URL when set; otherwise return it unchanged. */
export function dashboardLink(text: string): string {
  const url = env("DASHBOARD_URL");
  return url ? `<${url}|${text}>` : text;
}

/** Per-day keys for the current DISPLAY_TZ day. */
function dailyKeys(now: Date = new Date()): { dateKey: string; header: string; objKey: string } {
  const { y, mo, day } = tzParts(now);
  const dateKey = `${y}-${pad2(mo)}-${pad2(day)}`;
  const dp = headerDateFmt.formatToParts(now);
  const get = (t: string) => dp.find((p) => p.type === t)?.value ?? "";
  const tz = tzAbbrFmt.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
  // Only the "<basename> DB backup" name is linked; the whole header stays bold (Slack renders a
  // link inside *…*). With unfurl_links:false on every post, the link never expands to a preview.
  const name = dashboardLink(`${env("FILE_BASENAME")} DB backup`);
  const header = `*${name} — ${get("weekday")} ${get("day")} ${get("month")} ${get("year")} (${tz})*`;
  const objKey = `_status/${env("FILE_BASENAME")}/${dateKey}.json`;
  return { dateKey, header, objKey };
}

/**
 * Render the message text: header + real ticks (✅/❌, 🖐️-prefixed for manual) interleaved
 * with ⬜ placeholders for elapsed-but-empty 2-hourly buckets, sorted by label.
 * Pure — `now` drives which buckets are "due". Mirrors _slack_daily_text in slack.sh.
 */
export function renderDailyText(state: DailyState, now: Date = new Date()): string {
  const today = (() => {
    const { y, mo, day } = tzParts(now);
    return `${y}-${pad2(mo)}-${pad2(day)}`;
  })();
  const curH = tzParts(now).hour;

  // Buckets (0..SLOTS_PER_DAY-1) already covered by a real run — slot = floor(HH/2).
  const filled = new Set(state.entries.map((e) => Math.floor(Number(e.label.slice(0, 2)) / 2)));

  // "HH:00" labels for buckets that are DUE (elapsed) yet EMPTY. The +1 grace (2*s+1 <= curH)
  // waits an hour into a bucket before calling a tardy GitHub run "missing".
  const placeholders: string[] = [];
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    const due = state.date < today || (state.date === today && 2 * s + 1 <= curH);
    if (!due) continue;
    if (filled.has(s)) continue;
    placeholders.push(`${pad2(2 * s)}:00`);
  }

  const syms: { label: string; sym: string }[] = [];
  for (const e of state.entries) {
    const manual = e.manual ? "🖐️ " : "";
    const status = e.ok ? "✅ " : "❌ ";
    const marker = e.marker ? ` ${e.marker}` : "";
    syms.push({ label: e.label, sym: `${manual}${status}${e.label}${marker}` });
  }
  for (const label of placeholders) {
    syms.push({ label, sym: `⬜ ${label}` });
  }
  syms.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return `${state.header}\n${syms.map((s) => s.sym).join("  ·  ")}`;
}

/**
 * Load today's state JSON. Returns null (caller should SKIP) when R2 is unreachable or the
 * state is unreadable; returns a fresh state for a genuinely-absent day. A directory listing
 * gives a clean exists/absent signal; when in doubt, skip — a split row misleads and a
 * missing tick is benign. Mirrors _slack_daily_load.
 */
async function loadDaily(now: Date = new Date()): Promise<DailyState | null> {
  const bucket = env("R2_BUCKET");
  const basename = env("FILE_BASENAME");
  const { dateKey, header, objKey } = dailyKeys(now);

  const listing = await rcloneTry([
    "lsf",
    "--files-only",
    `r2:${bucket}/_status/${basename}/`,
    "--s3-no-check-bucket",
  ]);
  if (!listing.ok) {
    warn("cannot reach R2 to check today's Slack message — skipping Slack update this run");
    return null;
  }

  const present = listing.out
    .split("\n")
    .map((s) => s.trim())
    .includes(`${dateKey}.json`);
  if (!present) {
    return { channel: "", ts: "", date: dateKey, header, entries: [] };
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
  try {
    return JSON.parse(cat.out) as DailyState;
  } catch {
    warn("today's Slack state is unparseable JSON — skipping Slack update this run");
    return null;
  }
}

/**
 * Render + post (create) or update (existing) the day's message, then save state back to R2.
 * In "refresh" mode with no existing message, stays quiet (no all-empty row). Returns the
 * message ts. Persists via a temp file + copyto (a sized PUT) rather than rcat — R2 rejects
 * the streaming-signature upload rcat issues. Mirrors _slack_daily_persist.
 */
async function persistDaily(state: DailyState, mode: "create" | "refresh", now: Date = new Date()): Promise<string> {
  if (!state.ts && mode === "refresh") return "";
  const text = renderDailyText(state, now);
  if (!state.ts) {
    const ts = await slackPost(text);
    if (!ts) {
      warn("could not post daily slack message");
      return "";
    }
    state.ts = ts;
    state.channel = env("SLACK_CHANNEL");
  } else {
    await slackUpdate(state.ts, text);
  }

  const { objKey } = dailyKeys(now);
  const stateFile = join(tmpdir(), `slack-state-${process.pid}-${state.date}.json`);
  writeFileSync(stateFile, JSON.stringify(state));
  const put = capture("rclone", ["copyto", stateFile, `r2:${env("R2_BUCKET")}/${objKey}`, "--s3-no-check-bucket"]);
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
 * (for threading a failure alert). A truthy `manual` tags the tick with a 🖐️. Mirrors
 * slack_daily_record.
 */
export async function slackDailyRecord(
  ok: boolean,
  label: string,
  marker = "",
  manual = false,
  now: Date = new Date(),
): Promise<string> {
  if (!slackEnabled()) return "";
  const state = await loadDaily(now);
  if (!state) return "";
  state.entries = state.entries.filter((e) => e.label !== label).concat([{ label, ok, marker, manual }]);
  return persistDaily(state, "create", now);
}

/**
 * Re-render today's message in place (no new tick) so elapsed-but-empty buckets surface as
 * ⬜. No-op if today has no message yet. Mirrors slack_daily_refresh.
 */
export async function slackDailyRefresh(now: Date = new Date()): Promise<void> {
  if (!slackEnabled()) return;
  const state = await loadDaily(now);
  if (!state) return;
  await persistDaily(state, "refresh", now);
}
