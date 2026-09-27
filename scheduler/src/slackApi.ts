// ─────────────────────────────────────────────────────────────────────────────
// The Slack Web API calls, with every identifier passed in. The Worker is the only thing that posts
// to Slack: one the-gitfather app, whose bot token (chat:write + chat:write.customize) is a Worker
// secret and exists nowhere else — not in any client repo.
//
// Every helper is best-effort: a failed call RETURNS its Slack error code and never throws, and the
// caller decides whether the failure is worth retrying (isTransientSlackError).
// ─────────────────────────────────────────────────────────────────────────────

import type { SlackIdentity } from "./roster.js";

export interface SlackResult {
  ok: boolean;
  /** The message ts (post/update), "" otherwise. */
  ts: string;
  /** Slack's error code, `http_<status>` for a non-JSON reply, or `network_error`; "" on success. */
  error: string;
}

// Slack's own "try again" codes, plus ours for a request that never got a Slack answer. Everything
// else (invalid_auth, not_in_channel, channel_not_found, missing_scope, msg_too_long, …) will fail the
// same way on a retry, so the caller records it and moves on.
const TRANSIENT = new Set(["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout", "network_error"]);

export const isTransientSlackError = (code: string): boolean => TRANSIENT.has(code) || /^http_(5\d\d|429)$/.test(code);

/** POST one Web API method with a bot token. Hard 15s. Never throws. */
export async function slackCall(token: string, method: string, payload: Record<string, unknown>): Promise<SlackResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return { ok: false, ts: "", error: `http_${res.status}` };
    if (body.ok === true) return { ok: true, ts: typeof body.ts === "string" ? body.ts : "", error: "" };
    return { ok: false, ts: "", error: typeof body.error === "string" ? body.error : "unknown_error" };
  } catch {
    return { ok: false, ts: "", error: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** chat.postMessage, optionally threaded, under `identity` (display name + icon; chat:write.customize). */
export function postMessage(
  token: string,
  channel: string,
  text: string,
  opts: { thread?: string; broadcast?: boolean; identity?: SlackIdentity } = {},
): Promise<SlackResult> {
  const payload: Record<string, unknown> = { channel, text, unfurl_links: false, unfurl_media: false, ...opts.identity };
  if (opts.thread) {
    payload.thread_ts = opts.thread;
    payload.reply_broadcast = opts.broadcast ?? false;
  }
  return slackCall(token, "chat.postMessage", payload);
}

/**
 * chat.update in place. Slack keeps the name and icon the message was POSTED with — an update can't
 * change them — and only the app that posted a message may update it (`cant_update_message`).
 */
export function updateMessage(token: string, channel: string, ts: string, text: string): Promise<SlackResult> {
  return slackCall(token, "chat.update", { channel, ts, text, unfurl_links: false, unfurl_media: false });
}

/** auth.test — does the token still work? (No scope needed; it can't tell whether the bot is in a channel.) */
export const authTest = (token: string): Promise<SlackResult> => slackCall(token, "auth.test", {});

/**
 * Generic failure webhook, INDEPENDENT of the bot: a Slack-compatible {"text":…} POST to a client's
 * ALERT_WEBHOOK_URL_<ID>. Best-effort (never throws); fired on pages only — it can't update in place.
 */
export async function postWebhook(url: string, text: string): Promise<void> {
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } catch {
    /* best-effort — a failed alert must never mask the real failure */
  } finally {
    clearTimeout(timer);
  }
}
