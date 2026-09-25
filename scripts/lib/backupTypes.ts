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

import type { CellMark } from "./outcomes.js";

export type BackupTier = "2hourly" | "daily" | "weekly" | "monthly";

/**
 * Display timezone the dashboard + Slack row render in (the profile's DISPLAY_TZ; default UTC).
 * On the Node side (build-dashboard.ts) this reads `process.env.DISPLAY_TZ` at runtime; for the
 * browser bundle, build-dashboard.ts injects the value via esbuild `define`, so `process` is never
 * referenced at runtime there.
 */
export const DISPLAY_TZ = process.env.DISPLAY_TZ || "UTC";

// ── Backup cadence — DERIVED, never hardcoded ────────────────────────────────
// The slot width is the profile's `staleness.slot-minutes`, bridged into process.env by bootEnv
// (Node) and baked into the browser bundle by build-dashboard's esbuild `define` — the same route
// DISPLAY_TZ takes, for the same reason: these are read at MODULE LOAD.
//
// It is spelled out here because a hardcoded cadence has already shipped a dashboard that told
// readers "a fresh one every 2 hours, 3 a day" — self-contradictory, and wrong in both halves
// against an 8-hourly schedule. Only the "3" was derived; the "2 hours" was a literal left behind
// when the cadence changed. Anything that renders the cadence takes it from here.

/**
 * Slot width when no profile is loaded. `staleness.slot-minutes` takes its zod default FROM this
 * constant, so there is exactly one number: the two used to disagree (the schema said 120 while the
 * display hardcoded 3 slots/day, i.e. 480), which is half of why the dashboard could claim a
 * two-hourly cadence and a three-a-day count in the same sentence.
 */
export const DEFAULT_SLOT_MINUTES = 480;

/** Slots per day for a given slot width. `staleness.slot-minutes` is validated to divide 1440. */
export function slotsPerDayFrom(slotMinutes: number): number {
  return Math.round(1440 / slotMinutes);
}

export const SLOT_MINUTES = Number(process.env.SLOT_MINUTES) || DEFAULT_SLOT_MINUTES;
export const SLOTS_PER_DAY = slotsPerDayFrom(SLOT_MINUTES);
export const HOURS_PER_SLOT = 24 / SLOTS_PER_DAY; // display-slot width in hours
export const DAYS_PER_WEEK = 7;
export const COLS_PER_WEEK = SLOTS_PER_DAY * DAYS_PER_WEEK;

/** The cadence as an interval, e.g. "every 8 hours" / "every hour" / "every 90 minutes". */
function intervalPhrase(slotMinutes: number): string {
  if (slotMinutes % 60 !== 0) return `every ${slotMinutes} minutes`;
  const hours = slotMinutes / 60;
  return hours === 1 ? "every hour" : `every ${hours} hours`;
}

/**
 * The cadence split for rendering: a plain `lead` and the `emphasis` the subtitle highlights.
 * At one slot a day the count is dropped — "1 a day" adds nothing once the interval IS a day —
 * and the whole fragment moves into `emphasis`, because "every once a day" is not a sentence.
 */
export function slotCadence(slotMinutes: number = SLOT_MINUTES): { lead: string; emphasis: string } {
  if (slotMinutes >= 1440) return { lead: "a fresh one", emphasis: "once a day" };
  const interval = intervalPhrase(slotMinutes).replace(/^every /, "");
  return { lead: "a fresh one every", emphasis: `${interval}, ${slotsPerDayFrom(slotMinutes)} a day` };
}

/** The cadence as one flat fragment: "a fresh one every 8 hours, 3 a day". */
export function slotCadencePhrase(slotMinutes: number = SLOT_MINUTES): string {
  const { lead, emphasis } = slotCadence(slotMinutes);
  return `${lead} ${emphasis}`;
}

/**
 * The GFS ladder as one bullet per tier, oldest last, connectives included ("…, then", "…, and").
 * The subtitle renders these as a list; keeping the strings here means the tier windows, the
 * cadence adjective and the ordering are all covered by unit tests rather than by looking at a
 * rendered page.
 */
export function retentionBullets(r: RetentionMap, slotMinutes: number = SLOT_MINUTES): string[] {
  return [
    `the ${slotCadenceAdjective(slotMinutes)} “grandsons” are kept for ${r["2hourly"].label}, then`,
    `one “son” per day for ${r.daily.label},`,
    `one “father” per week for ${r.weekly.label}, and`,
    `one “grandfather” per month for ${r.monthly.label}`,
  ];
}

/** The cadence as an adjective for the grandson tier: "8-hourly" / "hourly" / "daily" / "90-minute". */
export function slotCadenceAdjective(slotMinutes: number = SLOT_MINUTES): string {
  if (slotMinutes >= 1440) return "daily";
  if (slotMinutes === 60) return "hourly";
  if (slotMinutes % 60 !== 0) return `${slotMinutes}-minute`;
  return `${slotMinutes / 60}-hourly`;
}

// ── GFS retention (configurable per profile; these are the defaults) ──────────
// The profile's `retention:` block sets these as natural-language durations; the loader parses them
// to { days, label } and build-dashboard.ts rides them into the PublicPayload, so the browser renders
// the real, possibly-overridden windows. R2 actually expires objects via lifecycle rules — these values
// are the source of truth the dashboard displays and the documented wrangler commands should match.

/** One tier's retention: `days` for expiry math, `label` (e.g. "13 weeks") for the dashboard subtitle. */
export interface TierRetention {
  days: number;
  label: string;
}
export type RetentionMap = Record<BackupTier, TierRetention>;

export const DEFAULT_RETENTION: RetentionMap = {
  "2hourly": { days: 2, label: "2 days" },
  daily: { days: 21, label: "3 weeks" },
  weekly: { days: 91, label: "13 weeks" },
  monthly: { days: 730, label: "2 years" },
};

/** Per-tier GFS name, cadence phrase, and copy-interval (days) — drives the subtitle + max-count math. */
export const TIER_META: Record<BackupTier, { gfs: string; every: string; cadenceDays: number }> = {
  // Key and label diverge on purpose: `2hourly/` is the frozen R2 object-key prefix (a legacy name
  // from when the cadence WAS two-hourly); `every` is the live cadence, derived.
  "2hourly": { gfs: "grandson", every: intervalPhrase(SLOT_MINUTES), cadenceDays: 1 / SLOTS_PER_DAY },
  daily: { gfs: "son", every: "every day", cadenceDays: 1 },
  weekly: { gfs: "father", every: "every week", cadenceDays: 7 },
  monthly: { gfs: "grandfather", every: "every month", cadenceDays: 365 / 12 },
};

/** Maximum number of backup copies alive at once across all tiers (Σ days/cadence, rounded). */
export function maxRetained(r: RetentionMap): number {
  return (Object.keys(TIER_META) as BackupTier[]).reduce(
    (n, t) => n + Math.round(r[t].days / TIER_META[t].cadenceDays),
    0,
  );
}

// ── Private log records (written by runlog.ts) ───────────────────────────────

export interface LogRun {
  /** ISO-8601 UTC stamp of the dump (the run's slot). */
  ts: string;
  ok: boolean;
  /** Tiers promoted to. Always includes "2hourly" on success; [] on failure. */
  tiers: BackupTier[];
  bytes: number | null;
  key: string | null;
  /** SHA-256 hex of the uploaded object (ciphertext for age). PRIVATE; the integrity baseline
   * for the durable hash-verify. null for runs predating this field or when hashing was skipped. */
  sha256: string | null;
  /** Sentinel-table row count(s) captured from the live DB AT DUMP TIME — the durable reference the
   * restore-drill / durable-verify live-ratio gate compares the RESTORED count against, instead of a
   * live-now estimate that drifts as the table grows between dump and verify. PRIVATE; never published.
   * null on records predating this field or when the count could not be taken (drill falls back to live). */
  counts: Record<string, number> | null;
  runId: string | null;
  runUrl: string | null;
  /** Raw failure reason — PRIVATE only, never published. */
  error: string | null;
  /**
   * Machine-readable twin of `error` (lib/pg-classify.ts PgFailureCode), so a consumer can act on
   * the CAUSE without prose-matching — the staleness watchdog quotes it in its page. PRIVATE, like
   * `error`. null on records predating this field, and on failures that never reached the database
   * (a missing binary, a config error). */
  errorCode: string | null;
  /** Whole backup-script wall time in ms (process start → run-log append). null on records
   * predating this field. PRIVATE — a dump-time trend signal, not published. */
  durationMs: number | null;
}

/**
 * One archive-task record, per TABLE per run → _log/<name>/archives-YYYY-MM.jsonl.
 *
 * Deliberately its OWN file rather than a row in runs-*.jsonl: LogRun is shaped around GFS tiers,
 * and archive records with `tiers: []` would render as malformed backup cells in the very heatmap
 * that exists to make a dropped backup obvious. Nothing renders this yet — it is written from day
 * one because observability cannot be backfilled; a dashboard panel added later would otherwise
 * arrive with no history behind it.
 */
export interface LogArchive {
  /** ISO-8601 UTC stamp of the run. */
  ts: string;
  ok: boolean;
  table: string;
  mode: "archive" | "prune" | "both";
  /** "none" for a real run; a dry run is recorded too, so the log explains a quiet week. */
  dryRun: "none" | "source" | "store";
  weeksArchived: number;
  rowsArchived: number;
  weeksPruned: number;
  rowsPruned: number;
  /** Bytes of archive object written this run (post-compression, post-encryption). */
  bytes: number | null;
  /** Prune refusals — the fingerprint gate declining to delete. Non-zero means a human must look. */
  refusals: number;
  /**
   * Invariant violations that need a human: rows found in an already-pruned week, or an archive
   * STALL (eligible weeks waiting and the run did less than its budget — see archiveFloor). Should
   * always be 0.
   */
  anomalies: number;
  /** Raw failure reason — PRIVATE, never published. */
  error: string | null;
  durationMs: number | null;
  runId: string | null;
  runUrl: string | null;
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

/**
 * One archive-task record, scrubbed for publication. Drops `error` (raw failure text is never
 * published, exactly as for LogRun), `runId` and `durationMs`, and publishes the SHORT table name —
 * the profile's schema layout is nobody else's business. Row counts and byte sizes ARE published,
 * following the same decision that already publishes dump sizes.
 */
export interface PublicArchiveRun {
  t: string; // ts
  ok: boolean;
  /** Schema-stripped table name (see lib/archive.ts shortTableName). */
  table: string;
  mode: "archive" | "prune" | "both";
  dryRun: "none" | "source" | "store";
  weeksArchived: number;
  rowsArchived: number;
  weeksPruned: number;
  rowsPruned: number;
  bytes: number | null;
  refusals: number;
  anomalies: number;
  runUrl: string | null;
}

/** One archived table and its windows — drives the column order and the header sentence. */
export interface PublicArchiveTable {
  /** Schema-stripped table name. */
  table: string;
  /** null when the table appears only in the log (dropped from the profile since it last ran). */
  archiveAfterWeeks: number | null;
  pruneAfterWeeks: number | null;
}

/**
 * One ISO week of one table's archive index, scrubbed for publication — the `_index/` view of what
 * happened to the rows DATED that week, as opposed to how a run went.
 *
 * The private record also carries per-part fingerprints, digests, part numbers and roles. None of
 * that is published: a digest is a gift to anyone reasoning about what is in the bucket, and the
 * page only needs the state and the size. `rows` is the ACTIVE part's row count (lib/archive.ts
 * activePart) — see lib/archiveIndex.ts, where the scrub happens.
 */
export interface PublicArchiveWeek {
  /** Schema-stripped table name, matching PublicArchiveRun.table. */
  table: string;
  /** ISO week label, e.g. "2026-W13". A calendar fact, not an instant. */
  week: string;
  state: ArchiveBodyState;
  rows: number;
  /**
   * Bytes of the archive object holding those rows — the stored size, exactly as a backup cell
   * reports its dump's size. Optional because it was added after the first indexes were written:
   * an older `_index/` line records no byte count, and a week without one must still render.
   */
  bytes?: number;
}

export interface PublicPayload {
  /** Generic project label, e.g. "mydb" (the profile's name / dashboard.label). */
  label: string;
  /** ISO-8601 UTC time the payload was built; used as "now" for expiry. */
  generatedAt: string;
  /** Per-tier retention windows in effect for this build (from the profile; defaults if absent). */
  retention: RetentionMap;
  runs: PublicRun[];
  verifications: PublicVerification[];
  /**
   * Row-retirement history, present only when the profile archives tables (or the log holds archive
   * records). Absent → the dashboard renders exactly as it did before archive columns existed: no
   * columns, no legend keys, no stats row, no blurb.
   */
  archive?: {
    tables: PublicArchiveTable[];
    runs: PublicArchiveRun[];
    /**
     * The `_index/` view: which weeks' ROWS are archived or pruned. ABSENT means "not read this
     * build" — no `_index/`, or a fetch that failed soft; `[]` means "read, and there was nothing
     * there". The two must stay distinguishable: one is a gap in what we know, the other is
     * something we know.
     */
    weeks?: PublicArchiveWeek[];
  };
}

// ── Derived grid types ───────────────────────────────────────────────────────

export type BackupCellState = "empty" | "failed" | "ok" | "verified" | "unverified" | "expired";

/** Origin of a run, driving the Slack-row marker: "schedule" (none), "manual" (🖐️), "self-heal" (🩹). */
export type { RunOrigin } from "./runOrigin.js";

/** One run within a slot (a cell can hold several — manual reruns, DST fall-back, …). */
export interface SlotRun {
  run: PublicRun;
  verification: PublicVerification | null;
  state: BackupCellState; // failed | ok | verified | expired
  /** Display-timezone wall-clock label, e.g. "Wed 19 Jun 2026, 2:00 am UTC". */
  whenLabel: string;
}

/**
 * What a backup slot HOLDS — the body channel. A strict subset of BackupCellState: `failed` is not
 * a body (a failed run produced no data, so the square stays blank and the mark carries it), and
 * `unverified` is not either (a dump whose drill failed is still a dump — the amber lives in the
 * mark, where it can coexist with the green).
 */
export type BackupBodyState = "ok" | "verified" | "expired";

export interface BackupCell {
  row: number; // 0 = most-recent week (top)
  col: number; // 0..COLS_PER_WEEK-1
  weekday: number; // 0=Mon … 6=Sun
  slot: number; // 0..SLOTS_PER_DAY-1
  /** All runs that fell in this slot, time-sorted (length >= 1). */
  runs: SlotRun[];
  /** The body: the best thing this slot holds, or null when every run failed. */
  body: BackupBodyState | null;
  /** The mark: did the runs in this slot go clean? See outcomes.ts. */
  mark: CellMark;
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

// ── Derived archive-column types ─────────────────────────────────────────────
// The archive block is a SIBLING of the backup grid, not an eighth day: same row pitch (so a run
// sits on the row of the week it happened in), one narrow column per table, its own states.

/**
 * An archive cell's state. Deliberately NOT reusing BackupCellState — an archive is not a backup,
 * it is the permanent home of rows that have left Postgres, and the two must not share a colour.
 *
 *   archived  — ran and moved work (bright archive hue)
 *   quiet     — ran, nothing was eligible, or it was a dry run (hollow)
 *   attention — prune refusals or anomalies: a human must look (amber, as for a failed drill)
 *   failed    — the run itself failed (red)
 */
export type ArchiveCellState = "archived" | "quiet" | "attention" | "failed";

/**
 * What an archive week HOLDS — the body channel, as opposed to how a run went.
 *
 * `pruned` is the brighter step of the blue ramp because a prune is gated on a fingerprint re-check
 * of the stored object: a pruned week is BY CONSTRUCTION a verified one, which is exactly what the
 * brighter green means on the backup side.
 */
export type ArchiveBodyState = "archived" | "pruned";

/** One archive record within a week/table cell (a cell can hold several — a manual backfill). */
export interface ArchiveSlotRun {
  run: PublicArchiveRun;
  state: ArchiveCellState;
  /** Display-timezone wall-clock label, e.g. "Mon 7 Sep 2026, 5:30 am AEST". */
  whenLabel: string;
}

export interface ArchiveCell {
  row: number; // 0 = most-recent week (top) — the same row index as the backup grid
  /** Short table name; the key into ArchiveColumns.tables. */
  table: string;
  /**
   * Archiver records that EXECUTED during this week, time-sorted. MAY BE EMPTY: a cell exists when
   * either channel has something to say, and the week whose rows moved is almost never the week the
   * archiver ran — the run that archives W30 sits five rows above W30's body.
   */
  runs: ArchiveSlotRun[];
  /**
   * The rows DATED this week — their lifecycle state and how many there are — from `_index/`.
   *
   * null when this week has no index entry, which deliberately cannot be told apart from a week
   * that had no rows: the index gains a week only when it is archived, so a backlog and an empty
   * week look the same. That limit is forced by the data rather than chosen.
   */
  data: { state: ArchiveBodyState; rows: number; bytes?: number } | null;
  /** The mark: did the archiver runs that happened this week go clean? See outcomes.ts. */
  mark: CellMark;
}

export interface ArchiveColumns {
  /** Short table names in column order: profile order first, then log-only stragglers. */
  tables: string[];
  /** One entry per week row, index-aligned with BackupGrid.rows: table → cell. */
  rows: Map<string, ArchiveCell>[];
}

export interface ArchiveStats {
  rowsArchived: number;
  rowsPruned: number;
  /** Runs that failed or need a look — the one number an operator should want to be zero. */
  issues: number;
  /**
   * Visible table-weeks whose rows are in the archive, and the subset already pruned from the
   * database. These come from the DATA channel, where the row counts above come from the runs —
   * two subjects, so they are hints on their cards rather than headline numbers.
   */
  weeksArchived: number;
  weeksPruned: number;
}

/**
 * The archive header sentence, split the way slotCadence splits the cadence: `emphasis` is the bit
 * the subtitle renders in <em>, so the wording stays a unit-tested pure string instead of markup
 * assembled in the renderer. Tables are referenced by their column label ("T1 api_logs") so the
 * sentence doubles as the key to the columns.
 */
export function archiveBlurb(tables: PublicArchiveTable[]): { lead: string; emphasis: string; tail: string } {
  const weeks = (n: number): string => `${n} week${n === 1 ? "" : "s"}`;
  const labels = tables.map((t, i) => `T${i + 1} ${t.table}`);
  const emphasis =
    labels.length <= 1
      ? (labels[0] ?? "")
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

  const lead = "Off to the right, one column per archived table — old rows of ";
  const opening = " leave Postgres for permanent per-week archive objects";
  // A table dropped from the profile keeps its column (its history is still real) but its windows
  // are no longer knowable, so it is left out of the schedule clause rather than guessed at.
  const known = tables.filter((t) => t.archiveAfterWeeks != null && t.pruneAfterWeeks != null);
  if (known.length === 0) return { lead, emphasis, tail: `${opening}.` };

  const uniform =
    known.length === tables.length &&
    known.every((t) => t.archiveAfterWeeks === known[0].archiveAfterWeeks && t.pruneAfterWeeks === known[0].pruneAfterWeeks);
  if (uniform) {
    return {
      lead,
      emphasis,
      tail:
        `${opening}: archived once ${weeks(known[0].archiveAfterWeeks!)} old, ` +
        `deleted from the database once ${weeks(known[0].pruneAfterWeeks!)} old.`,
    };
  }
  const each = known.map(
    (t) => `${t.table} archived once ${weeks(t.archiveAfterWeeks!)} old and deleted once ${weeks(t.pruneAfterWeeks!)} old`,
  );
  return { lead, emphasis, tail: `${opening}, each on its own schedule: ${each.join("; ")}.` };
}
