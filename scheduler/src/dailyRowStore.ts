// ─────────────────────────────────────────────────────────────────────────────
// The daily Slack status row — the Worker is its only writer. Two things write it: delivering a
// backup's outcome (a ✅/❌ tick) and the Slack tick's refresh (⬜ placeholders as slots elapse). Both
// can run at once, so every state write is a compare-and-swap on the object's etag; a lost race
// re-reads, re-merges (entries are keyed by label, so re-applying one is harmless) and tries again.
//
// A message this app can't edit — the old per-client bots' rows on cutover day, or one deleted by
// hand — is re-posted rather than left stale, so the row carries on (a duplicate row that day is the
// cost). The one race left: two writers both creating the day's FIRST message at the same instant can
// leave one orphaned duplicate. That is rare (first backup of the day vs a refresh) and cosmetic.
// ─────────────────────────────────────────────────────────────────────────────

import { dailyHeaderIn, dailyStateKey, dateKeyIn, parseDailyState, renderDailyTextIn, type DailyEntry, type DailyState, type RowContext } from "../../scripts/lib/dailyRow.js";
import { JSON_TYPE, type ObjectStore } from "./objectStore.js";
import type { SlackPort } from "./slackPort.js";

/** Slack errors meaning "that message is not ours to edit, or is gone" — post a new one instead. */
const REPOST_ERRORS = new Set(["cant_update_message", "message_not_found", "edit_window_closed"]);

export interface RowTarget {
  /** The profile name as stored — names the state object. */
  stateName: string;
  /** Display-safe context (outcomeRender.ts displayContext). */
  ctx: RowContext;
}

export interface RowResult {
  ok: boolean;
  /** Slack's error code when a post/update failed. */
  error?: string;
  /** Nothing to do: no row yet (refresh), or the text is unchanged. */
  skipped?: boolean;
  /** The row message's ts, when there is one — a backup's failure page threads under it. */
  ts?: string;
}

const MAX_ATTEMPTS = 3;

/**
 * Tick `entry` onto the row for `day` (posting the row if it doesn't exist yet), or — with no entry —
 * refresh the existing row so elapsed slots show ⬜. `now` drives which slots count as elapsed.
 */
export async function upsertDailyRow(
  store: ObjectStore,
  slack: SlackPort,
  target: RowTarget,
  opts: { day: Date; now: Date; entry?: DailyEntry; log?: (line: string) => void },
): Promise<RowResult> {
  const { ctx } = target;
  const log = opts.log ?? (() => {});
  const dateKey = dateKeyIn(opts.day, ctx.tz);
  const key = dailyStateKey(target.stateName, dateKey);
  let postedTs = ""; // a message THIS call posted — reused on a retry rather than posting another

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const obj = await store.get(key);
    let state: DailyState | null = obj ? parseDailyState(await obj.text()) : null;
    if (obj && !state) log(`daily row ${key} is unreadable — starting it afresh`);
    if (!state && !opts.entry) return { ok: true, skipped: true }; // a refresh never creates an empty row
    state ??= { channel: "", ts: "", date: dateKey, header: "", entries: [] };

    if (opts.entry) {
      const e = opts.entry;
      state.entries = state.entries.filter((x) => x.label !== e.label).concat([e]);
    } else if (state.entries.length === 0) {
      return { ok: true, skipped: true };
    }
    if (!state.ts && postedTs) {
      state.ts = postedTs;
      state.channel = slack.channel;
    }
    // The roster moved this client to another channel: start the day's row afresh there.
    if (state.ts && state.channel !== slack.channel) state.ts = "";
    // The header is the ROW's day, not today's: a backup that finishes just after midnight still
    // ticks yesterday's row, and must not relabel it.
    state.header = dailyHeaderIn(opts.day, ctx);
    const text = renderDailyTextIn(state, opts.now, ctx);
    if (!opts.entry && state.ts && state.text === text) return { ok: true, skipped: true, ts: state.ts };

    let error: string | undefined;
    if (state.ts) {
      const r = await slack.update(state.ts, text);
      if (r.ok) state.text = text;
      else if (REPOST_ERRORS.has(r.error)) {
        log(`daily row: chat.update failed (${r.error}) — posting a new row`);
        state.ts = "";
      } else error = r.error;
    }
    if (!state.ts && !error) {
      const r = await slack.post(text);
      if (r.ok && r.ts) {
        state.ts = postedTs = r.ts;
        state.channel = slack.channel;
        state.text = text;
      } else error = r.error || "no_ts";
    }

    // Persist even when Slack failed: the entry must not be lost, and the stale `text` makes the next
    // refresh try again.
    const put = await store.put(key, JSON.stringify(state), { httpMetadata: JSON_TYPE, ...(obj ? { onlyIf: { etagMatches: obj.etag } } : {}) });
    if (put) return error ? { ok: false, error, ...(state.ts ? { ts: state.ts } : {}) } : { ok: true, ts: state.ts };
    log(`daily row ${key}: changed under us — retrying (${attempt}/${MAX_ATTEMPTS})`);
  }
  return { ok: false, error: "state_conflict" };
}
