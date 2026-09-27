// ─────────────────────────────────────────────────────────────────────────────
// One client's Slack: the Worker's single bot token, bound to the channel and identity the roster
// gives that client. Everything that posts — the watchdog's pages, outcome delivery, the daily row —
// goes through a port, so no caller can pick a channel or a name for itself.
// ─────────────────────────────────────────────────────────────────────────────

import { slackIdentity, type Client } from "./roster.js";
import { postMessage, updateMessage, type SlackResult } from "./slackApi.js";

export interface SlackPort {
  readonly channel: string;
  post(text: string, opts?: { thread?: string; broadcast?: boolean }): Promise<SlackResult>;
  update(ts: string, text: string): Promise<SlackResult>;
}

/** The client's port, or null when Slack is off for it (no token, or no `slack` block in its roster entry). */
export function slackPortFor(token: string | undefined, client: Client): SlackPort | null {
  const channel = client.slack?.channel;
  if (!token || !channel) return null;
  const identity = slackIdentity(client);
  return {
    channel,
    post: (text, opts = {}) => postMessage(token, channel, text, { ...opts, identity }),
    update: (ts, text) => updateMessage(token, channel, ts, text),
  };
}
