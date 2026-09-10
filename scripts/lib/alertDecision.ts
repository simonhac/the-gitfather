// ─────────────────────────────────────────────────────────────────────────────
// Alert episode state for the staleness watchdog — page on entry, then throttle. PURE.
//
// The watchdog runs every 10 minutes and, while a backup is broken, used to fire a mentioning
// @here alert on EVERY tick. The 2026-08-04 outage therefore produced ~96 identical pages over
// 16 hours, which is how an alert stops being an alert. Nothing was wrong with the detection —
// only with the repetition — so this module governs Slack noise and NOTHING else.
//
// Node-free on purpose: the watchdog now runs inside the Cloudflare Worker (scheduler/src/watchdog.ts)
// and bundles this file, so the decision the Worker makes is the decision the tests here pin down.
// The R2 persistence for the Actions-side scripts lives next door in alert-state.ts.
//
// Failure direction is deliberate: anything unreadable, unparseable or ambiguous resolves to PAGE.
// An extra page is a nuisance; a swallowed one is the thing this whole system exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

export interface AlertState {
  kind: "stale";
  /** Classified cause (a PgFailureCode), or null when the watchdog couldn't determine one. */
  cause: string | null;
  /** ISO-8601 — when this alert EPISODE began. Preserved across re-pages; drives "recovered after N". */
  since: string;
  /** ISO-8601 — the last loud page. Only a page moves this. */
  lastPagedAt: string;
}

export type AlertDecision =
  | { page: true; reason: "new" | "cause-changed" | "repage" }
  | { page: false; nextPageInMinutes: number };

/** The object that persists an episode, next to the daily Slack rows: _status/<basename>/alert-state.json. */
export const alertStateKey = (basename: string): string => `_status/${basename}/alert-state.json`;

function epoch(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * Should this tick page loudly? `cause` is the classified failure code (null when unknown).
 * `repageMinutes <= 0` disables throttling entirely — an escape hatch for a profile that would
 * rather have the noise.
 */
export function decideAlert(
  prev: AlertState | null,
  nowMs: number,
  cause: string | null,
  repageMinutes: number,
): AlertDecision {
  if (!prev) return { page: true, reason: "new" };
  if (repageMinutes <= 0) return { page: true, reason: "repage" };
  // A different cause is different information — surface it now, not at the end of the window.
  if ((prev.cause ?? null) !== (cause ?? null)) return { page: true, reason: "cause-changed" };

  const last = epoch(prev.lastPagedAt);
  if (Number.isNaN(last)) return { page: true, reason: "new" }; // unreadable state ⇒ page

  const elapsedMs = nowMs - last;
  const windowMs = repageMinutes * 60_000;
  if (elapsedMs >= windowMs) return { page: true, reason: "repage" };
  return { page: false, nextPageInMinutes: Math.ceil((windowMs - elapsedMs) / 60_000) };
}

/** The state to persist after acting on `decision`. A quiet tick must NOT move lastPagedAt. */
export function advanceAlertState(
  prev: AlertState | null,
  nowMs: number,
  cause: string | null,
  decision: AlertDecision,
): AlertState {
  const nowIso = new Date(nowMs).toISOString();
  const sincePrev = prev && !Number.isNaN(epoch(prev.since)) ? prev.since : nowIso;
  return {
    kind: "stale",
    cause: cause ?? null,
    since: sincePrev,
    lastPagedAt: decision.page ? nowIso : (prev?.lastPagedAt ?? nowIso),
  };
}

/** Parse a persisted state; anything malformed reads as absent (⇒ the next tick pages). */
export function parseAlertState(raw: string): AlertState | null {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as Partial<AlertState> | null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (v.kind !== "stale") return null;
    if (typeof v.since !== "string" || typeof v.lastPagedAt !== "string") return null;
    return {
      kind: "stale",
      cause: typeof v.cause === "string" ? v.cause : null,
      since: v.since,
      lastPagedAt: v.lastPagedAt,
    };
  } catch {
    return null;
  }
}
