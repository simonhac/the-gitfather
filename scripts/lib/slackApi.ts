// ─────────────────────────────────────────────────────────────────────────────
// The Slack Web API calls, with every identifier passed in — no profile, no env, no Node.
//
// Shared by lib/slack.ts (Actions-side, which binds the token/channel from the profile) and the
// Cloudflare Worker's watchdog (which binds them from its secrets + the published watchdog config).
// Every helper is best-effort: a failed call returns ""/false and NEVER throws to the caller.
// ─────────────────────────────────────────────────────────────────────────────

export interface SlackApiResult {
  ok: boolean;
  body: Record<string, unknown>;
}

/** POST one Web API method with a bot token. Hard 15s (mirrors the old `curl -m 15`). Never throws. */
export async function slackCall(token: string, method: string, payload: Record<string, unknown>): Promise<SlackApiResult> {
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
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: body.ok === true, body };
  } catch {
    return { ok: false, body: {} };
  } finally {
    clearTimeout(timer);
  }
}

/** chat.postMessage → the new message ts ("" on failure). `onError` receives Slack's error code. */
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  opts: { thread?: string; broadcast?: boolean; onError?: (error: string) => void } = {},
): Promise<string> {
  const payload: Record<string, unknown> = { channel, text, unfurl_links: false, unfurl_media: false };
  if (opts.thread) {
    payload.thread_ts = opts.thread;
    payload.reply_broadcast = opts.broadcast ?? false;
  }
  const resp = await slackCall(token, "chat.postMessage", payload);
  if (!resp.ok) {
    opts.onError?.(String(resp.body.error ?? "?"));
    return "";
  }
  return typeof resp.body.ts === "string" ? resp.body.ts : "";
}

/** chat.update in place. Returns whether Slack accepted it. */
export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
  opts: { onError?: (error: string) => void } = {},
): Promise<boolean> {
  const resp = await slackCall(token, "chat.update", { channel, ts, text, unfurl_links: false, unfurl_media: false });
  if (!resp.ok) opts.onError?.(String(resp.body.error ?? "?"));
  return resp.ok;
}

/**
 * Generic failure webhook, INDEPENDENT of the bot: a Slack-compatible {"text":…} POST. Best-effort
 * (never throws); callers fire it on FAILURE only — it can't update in place. Hard 10s.
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
