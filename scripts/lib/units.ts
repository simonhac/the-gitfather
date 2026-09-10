// ─────────────────────────────────────────────────────────────────────────────
// One typographic rule: a number and the word it measures are a single token.
//
// "5.9 MB" broken across two lines reads as two facts, and in a 240px tooltip that happens
// constantly — "Archived 2 weeks · 97,274 rows · 5.9 / MB" is genuinely harder to read than the
// same line one word narrower would be.
//
// The fix is applied to RENDERED TEXT rather than threaded through the string builders, and that is
// the whole design of this module. Every count in the page is assembled somewhere different — the
// tooltips here, the prose in backupTypes.ts, tier labels parsed out of the profile in config.ts —
// so binding at the source would mean an invisible U+00A0 in a dozen template literals and in every
// test that asserts one. Binding at the sink is one rule, applied once, that no new caller can
// forget.
// ─────────────────────────────────────────────────────────────────────────────

/** U+00A0. Spelled out because it is invisible in source and in test failures. */
export const NBSP = "\u00a0";

/**
 * A digit, then a space, then a letter: bind them.
 *
 * The lookahead is deliberately letters only. A space between two digits is a thousands separator
 * or a date ("2026, 7:30"), and a space before punctuation ("· 1 — Archived") is a real break
 * opportunity the panel needs — gluing those would only make the box wider for no gain.
 */
const NUMBER_THEN_UNIT = /(\d) (?=\p{L})/gu;

/**
 * "5.9 MB", "3,045 rows", "2 weeks", "10 Sept", "8:00 am" — each becomes unbreakable.
 *
 * Idempotent: text already bound has no plain space left to match, so re-running over a panel that
 * was rebuilt from bound text is a no-op rather than a corruption.
 */
export function bindUnits(text: string): string {
  return text.replace(NUMBER_THEN_UNIT, `$1${NBSP}`);
}
