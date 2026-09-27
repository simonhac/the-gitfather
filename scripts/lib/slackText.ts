// ─────────────────────────────────────────────────────────────────────────────
// Making text safe to put in a Slack message.
//
// The scheduler Worker is the only thing that posts to Slack, and much of what it posts comes out of
// a client's private bucket — outcome records, the run-log, the published watchdog config — which
// anyone holding that client's CI R2 key can write. So everything from there is treated as untrusted:
// escaped (Slack mrkdwn's three control characters), stripped of control characters, capped, and —
// for free text — put in a code span, where Slack neither formats nor auto-links. Mentions are never
// taken from free text: the only mention the Worker adds is the profile's `alert-mention`, and that
// must match a small grammar (safeMention) — enforced when the profile is validated AND again when the
// Worker reads the published copy.
//
// Node-free: shared by lib/config.ts (the zod refine) and the Worker.
// ─────────────────────────────────────────────────────────────────────────────

/** `<!here>`, `<!channel>`, a user `<@U…>`/`<@W…>`, or a user group `<!subteam^S…>` — up to 4, space-separated. */
const MENTION_TOKEN = /^(<!here>|<!channel>|<@[UW][A-Z0-9]{2,20}>|<!subteam\^S[A-Z0-9]{2,20}>)$/;

export const DEFAULT_MENTION = "<!here>";

/** True when `m` is one to four allowed mention tokens separated by single spaces. */
export function isSafeMention(m: string): boolean {
  const tokens = m.split(" ");
  return tokens.length >= 1 && tokens.length <= 4 && tokens.every((t) => MENTION_TOKEN.test(t));
}

/** `m` when it is a safe mention, else the default. */
export const safeMention = (m: string | null | undefined): string => (m && isSafeMention(m) ? m : DEFAULT_MENTION);

/**
 * Escape Slack's control characters (& < >), turn control characters and newlines into spaces, collapse
 * runs of whitespace and cap the length. Leaves `*`/`_`/backticks alone: formatting, not injection.
 */
export function escapeSlack(s: string, max = 500): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const capped = flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
  return capped.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Untrusted free text as an inline code span: escaped, backticks neutralised, capped. */
export function codeSpan(s: string, max = 500): string {
  return `\`${escapeSlack(s.replace(/`/g, "'"), max)}\``;
}

/**
 * An https URL that is safe inside Slack's `<url|label>` link syntax, else "". Rejects anything that
 * could end the link early or smuggle markup (`|`, `<`, `>`, whitespace).
 */
export function safeUrl(u: string | null | undefined): string {
  if (!u || u.length > 500 || /[|<>\s]/.test(u)) return "";
  try {
    return new URL(u).protocol === "https:" ? u : "";
  } catch {
    return "";
  }
}
