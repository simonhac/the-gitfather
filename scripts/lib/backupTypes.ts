// ─────────────────────────────────────────────────────────────────────────────
// Shared types for the backup run-log and the dashboard.
//
//   LogRun / LogVerification  — the rich records appended to the PRIVATE R2 logs
//                               (_log/<basename>/{runs,verifications}-YYYY-MM.jsonl)
//   PublicRun / PublicVerification / PublicPayload
//                             — the scrubbed shape inlined into the PUBLIC dashboard
//                               (build-dashboard.ts maps Log* → Public*, dropping raw
//                               error text; see the privacy note in build-dashboard.ts)
//
// The dashboard logic (backupHistory.ts) works on the Public* shape so the browser
// bundle only ever sees scrubbed data.
// ─────────────────────────────────────────────────────────────────────────────

export type BackupTier = "2hourly" | "daily" | "weekly" | "monthly";

/** GFS lifecycle expiry per tier, in days (mirrors the R2 lifecycle rules in your profile). */
export const TIER_RETENTION_DAYS: Record<BackupTier, number> = {
  "2hourly": 2,
  daily: 21,
  weekly: 70,
  monthly: 400,
};

/**
 * Display timezone the dashboard + Slack row render in (the profile's DISPLAY_TZ; default UTC).
 * On the Node side (build-dashboard.ts) this reads `process.env.DISPLAY_TZ` at runtime; for the
 * browser bundle, build-dashboard.ts injects the value via esbuild `define`, so `process` is never
 * referenced at runtime there.
 */
export const DISPLAY_TZ = process.env.DISPLAY_TZ || "UTC";

export const SLOTS_PER_DAY = 12; // 2-hourly
export const DAYS_PER_WEEK = 7;
export const COLS_PER_WEEK = SLOTS_PER_DAY * DAYS_PER_WEEK; // 84

// ── Private log records (written by runlog.ts) ───────────────────────────────

export interface LogRun {
  /** ISO-8601 UTC stamp of the dump (the run's 2-hourly slot). */
  ts: string;
  ok: boolean;
  /** Tiers promoted to. Always includes "2hourly" on success; [] on failure. */
  tiers: BackupTier[];
  bytes: number | null;
  key: string | null;
  /** SHA-256 hex of the uploaded object (ciphertext for age). PRIVATE; the integrity baseline
   * for the durable hash-verify. null for runs predating this field or when hashing was skipped. */
  sha256: string | null;
  runId: string | null;
  runUrl: string | null;
  /** Raw failure reason — PRIVATE only, never published. */
  error: string | null;
}

export interface LogVerification {
  ts: string;
  /** The dump stamp the drill restored & verified (matches a LogRun.ts). */
  verifiedTs: string;
  ok: boolean;
  ratio: number | null;
  runId: string | null;
  runUrl: string | null;
  /** Which durable copy was tested (null = a legacy/2hourly drill record). */
  tier?: BackupTier | null;
  /** The exact object key tested (null on legacy records). */
  key?: string | null;
  /** "restore" = full pg_restore + row counts; "hash" = byte-integrity check of the stored object.
   * Missing on legacy records → treat as "restore". */
  kind?: "restore" | "hash";
  /** Restored per-table row counts (drift signal). PRIVATE — never published. */
  counts?: Record<string, number> | null;
  /** Private failure reason (mirrors LogRun.error) — never published. */
  reason?: string | null;
}

// ── Public (scrubbed) payload inlined into the dashboard ──────────────────────

export interface PublicRun {
  t: string; // ts
  ok: boolean;
  tiers: BackupTier[];
  bytes: number | null;
  runUrl: string | null;
}

export interface PublicVerification {
  vt: string; // verifiedTs
  ok: boolean;
  ratio: number | null;
  kind?: "restore" | "hash"; // for the dashboard tooltip; counts/reason/key/tier stay private
}

export interface PublicPayload {
  /** Generic project label, e.g. "mydb" (the profile's FILE_BASENAME / DASHBOARD_LABEL). */
  label: string;
  /** ISO-8601 UTC time the payload was built; used as "now" for expiry. */
  generatedAt: string;
  runs: PublicRun[];
  verifications: PublicVerification[];
}

// ── Derived grid types ───────────────────────────────────────────────────────

export type BackupCellState = "empty" | "failed" | "ok" | "verified" | "unverified" | "expired";

/** Origin of a run, driving the Slack-row marker: "schedule" (none), "manual" (🖐️), "self-heal" (🩹). */
export type RunOrigin = "schedule" | "manual" | "self-heal";

/** One run within a slot (a cell can hold several — manual reruns, DST fall-back, …). */
export interface SlotRun {
  run: PublicRun;
  verification: PublicVerification | null;
  state: BackupCellState; // failed | ok | verified | expired
  /** Display-timezone wall-clock label, e.g. "Wed 19 Jun 2026, 2:00 am UTC". */
  whenLabel: string;
}

export interface BackupCell {
  row: number; // 0 = most-recent week (top)
  col: number; // 0..83
  weekday: number; // 0=Mon … 6=Sun
  slot: number; // 0..11
  /** All runs that fell in this slot, time-sorted (length >= 1). */
  runs: SlotRun[];
  /** Headline state — the best success among the runs, else "failed". Drives summary/legend. */
  state: BackupCellState;
  /** Best of verified/ok/expired among the successful runs (null if all failed). */
  successState: BackupCellState | null;
  /** True if any run in the slot failed. */
  hasFailure: boolean;
  /** True if the slot holds more than one run (→ notch + possible diagonal split). */
  multiple: boolean;
}

export interface BackupRow {
  weekStartOrdinal: number;
  weekStartLabel: string;
  cells: Map<number, BackupCell>;
}

export interface BackupGrid {
  rows: BackupRow[];
  weeks: number;
}

export interface BackupStats {
  total: number;
  ok: number;
  verified: number;
  unverified: number;
  failed: number;
  expired: number;
  latestLabel: string | null;
  latestState: BackupCellState | null;
}
