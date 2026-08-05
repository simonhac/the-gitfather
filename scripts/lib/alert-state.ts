// ─────────────────────────────────────────────────────────────────────────────
// Alert episode state for the staleness watchdog — page on entry, then throttle.
//
// The watchdog runs every 10 minutes and, while a backup is broken, used to fire a mentioning
// @here alert on EVERY tick. The 2026-08-04 outage therefore produced ~96 identical pages over
// 16 hours, which is how an alert stops being an alert. Nothing was wrong with the detection —
// only with the repetition — so this module governs Slack noise and NOTHING else: the job still
// exits non-zero on every stale tick, so the red X in Actions and the dashboard are unchanged.
//
// The decision is a pure function so the arms that matter (a cause changing mid-window, a corrupt
// state object, throttling switched off) are testable without a broken database or a 60-minute wait.
// The persisted half lives in R2 next to the daily Slack rows: _status/<basename>/alert-state.json.
//
// Failure direction is deliberate: anything unreadable, unparseable or ambiguous resolves to PAGE.
// An extra page is a nuisance; a swallowed one is the thing this whole system exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./proc.js";

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

// ── R2 persistence ───────────────────────────────────────────────────────────
// Mirrors lib/slack.ts's daily-row storage (same bucket, same _status/<basename>/ prefix, same
// rclone-from-env configuration). All three helpers are best-effort by design: a read failure
// resolves to null (⇒ page), and a write failure only costs an extra page next tick.

const objKey = (basename: string) => `_status/${basename}/alert-state.json`;

export function readAlertState(bucket: string, basename: string): AlertState | null {
  const r = capture("rclone", ["cat", `r2:${bucket}/${objKey(basename)}`, "--s3-no-check-bucket"]);
  return r.ok ? parseAlertState(r.out) : null;
}

export function writeAlertState(bucket: string, basename: string, state: AlertState): boolean {
  // Via a temp file + copyto, exactly as slack.ts persists the daily row — capture() wires the
  // child's stdin to "ignore", so an `rclone rcat` here would upload an empty object.
  const file = join(tmpdir(), `alert-state-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(state));
  try {
    return capture("rclone", ["copyto", file, `r2:${bucket}/${objKey(basename)}`, "--s3-no-check-bucket"]).ok;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

export function clearAlertState(bucket: string, basename: string): boolean {
  const r = capture("rclone", ["deletefile", `r2:${bucket}/${objKey(basename)}`, "--s3-no-check-bucket"]);
  return r.ok;
}
