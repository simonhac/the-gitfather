// ─────────────────────────────────────────────────────────────────────────────
// Pure logic for the table archiver: ISO-week windows, object keys, the set
// fingerprint, and the part/prune state machine.
//
// This module is deliberately DEPENDENCY-FREE (no zod, no fs, no config.ts) — it is the
// part that has to be provably right, and config.ts already imports backupTypes.ts, which
// captures DISPLAY_TZ at module load. Importing config here would drag that evaluation in
// ahead of bootEnv and create a cycle once config.ts grows an archive schema.
//
// Two ideas carry the whole design:
//
//   1. WEEKS ARE HALF-OPEN, TILED, UTC. Every row belongs to exactly one ISO week
//      [monday 00:00Z, next monday 00:00Z). Weeks tile the timeline with no gap and no
//      overlap, so "archive everything older than N weeks" can never double-count or skip.
//      The folder is the ISO week-NUMBERING year (2026-W01 files under 2026/ even though it
//      starts 2025-12-29), so the label and the folder can never disagree.
//
//   2. THE FINGERPRINT IS COMPUTABLE ON BOTH SIDES WITHOUT DECRYPTING. count(*) plus an
//      order-independent 64-bit XOR of md5(id). Postgres computes it with
//      `bit_xor(('x'||substr(md5(id::text),1,16))::bit(64))`; xorDigest() computes the
//      identical value in Node from the NDJSON. That is what lets a prune prove the live
//      row set still equals the archived row set — using only the plaintext manifest, with
//      the archive key nowhere near CI. XOR is used rather than a hash over sorted ids
//      because it is order-independent AND constant-memory: string_agg over millions of
//      uuids would allocate hundreds of MB inside Postgres.
//
// A note on why prune REFUSES rather than repairs: deleting rows that were never durably
// stored is the one unrecoverable failure mode in this system. Every ambiguous state below
// resolves toward "keep the rows and shout", never toward "delete and hope".
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

// ── ISO 8601 weeks ───────────────────────────────────────────────────────────

export interface IsoWeek {
  /** ISO week-numbering year — NOT necessarily the calendar year of `start`. */
  year: number;
  /** 1..53 */
  week: number;
  /** "2026-W23" */
  label: string;
  /** Monday 00:00:00.000Z, inclusive. */
  start: Date;
  /** The following Monday 00:00:00.000Z, EXCLUSIVE. */
  end: Date;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Monday (UTC ms) of ISO week 1 of `year` — the Monday of the week containing 4 January. */
function isoWeek1Monday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return jan4 - dow * DAY_MS;
}

/**
 * 53 when the ISO year has a 53rd week — i.e. when 1 January is a Thursday, or a Wednesday
 * in a leap year. Used to reject "2025-W53", which looks well-formed but does not exist.
 */
export function weeksInIsoYear(year: number): number {
  const jan1Dow = new Date(Date.UTC(year, 0, 1)).getUTCDay(); // 0=Sun … 4=Thu
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return jan1Dow === 4 || (isLeap && jan1Dow === 3) ? 53 : 52;
}

function weekFromMonday(mondayMs: number): IsoWeek {
  // The ISO year is the year of the week's THURSDAY — that is the definition, and it is why
  // a week can be labelled with a year none of its January/December days belong to.
  const thursday = mondayMs + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.round((mondayMs - isoWeek1Monday(year)) / WEEK_MS);
  return {
    year,
    week,
    label: `${year}-W${pad2(week)}`,
    start: new Date(mondayMs),
    end: new Date(mondayMs + WEEK_MS),
  };
}

/** The ISO week containing `d`. */
export function isoWeekOf(d: Date): IsoWeek {
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(midnight).getUTCDay() + 6) % 7; // Mon=0
  return weekFromMonday(midnight - dow * DAY_MS);
}

/** The ISO week (year, week). Throws if that week does not exist in that ISO year. */
export function isoWeek(year: number, week: number): IsoWeek {
  if (!Number.isInteger(week) || week < 1 || week > weeksInIsoYear(year)) {
    throw new Error(`invalid ISO week label "${year}-W${pad2(week)}" — ${year} has ${weeksInIsoYear(year)} ISO weeks`);
  }
  return weekFromMonday(isoWeek1Monday(year) + (week - 1) * WEEK_MS);
}

/** Parse "2026-W23". Strict: 4-digit year, literal uppercase W, 2-digit week that really exists. */
export function parseWeekLabel(label: string): IsoWeek {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new Error(`invalid ISO week label "${label}" — expected e.g. "2026-W23"`);
  return isoWeek(Number(m[1]), Number(m[2]));
}

/** The next week along. Pure UTC arithmetic, so there is no DST edge to get wrong. */
export function nextWeek(w: IsoWeek): IsoWeek {
  return weekFromMonday(w.start.getTime() + WEEK_MS);
}

/**
 * The previous week. Stepping by milliseconds rather than decrementing the week number is what
 * makes the year boundary safe: 2027-W01 → 2026-W53 changes the year AND the week, and 2026 has
 * a 53rd week where 2025 does not.
 */
export function prevWeek(w: IsoWeek): IsoWeek {
  return weekFromMonday(w.start.getTime() - WEEK_MS);
}

/** The newest week that is already past the `afterWeeks` horizon relative to `now`. */
export function newestEligibleWeek(now: Date, afterWeeks: number): IsoWeek {
  let w = isoWeekOf(now);
  for (let guard = 0; guard < 10_000; guard++) {
    if (isWeekEligible(w, now, afterWeeks)) return w;
    w = prevWeek(w);
  }
  return w;
}

// ── Eligibility ──────────────────────────────────────────────────────────────

/**
 * True when EVERY row in `w` is at least `afterWeeks` weeks old — the test is on the week's
 * END, not its start. "Older than 4 weeks" has to mean the newest row in the window is also
 * 4 weeks old, otherwise a week archived on its start boundary would sweep up rows that are
 * only days old. A consequence worth knowing: with afterWeeks=0 the in-progress week is
 * still excluded, because its end is in the future.
 */
export function isWeekEligible(w: IsoWeek, now: Date, afterWeeks: number): boolean {
  return w.end.getTime() + afterWeeks * WEEK_MS <= now.getTime();
}

/**
 * The weeks to work on this run, OLDEST FIRST — so an interrupted backfill always resumes at
 * the oldest outstanding week and the archive fills in monotonically. `done` (labels already
 * archived, read from the store's index) makes the walk resumable without any local state;
 * `maxWeeks` bounds a run so a legacy backlog can be worked off in deliberate batches.
 */
export function eligibleWeeks(opts: {
  now: Date;
  oldestRowAt: Date | null;
  afterWeeks: number;
  maxWeeks: number;
  done: Set<string>;
}): IsoWeek[] {
  const { now, oldestRowAt, afterWeeks, maxWeeks, done } = opts;
  if (!oldestRowAt || maxWeeks <= 0) return [];

  const out: IsoWeek[] = [];
  let w = isoWeekOf(oldestRowAt);
  // Bounded by construction (each step advances a week and the loop stops at the eligibility
  // horizon), but a hard cap keeps a bad clock from spinning forever.
  for (let guard = 0; guard < 100_000 && out.length < maxWeeks; guard++) {
    if (!isWeekEligible(w, now, afterWeeks)) break;
    if (!done.has(w.label)) out.push(w);
    w = nextWeek(w);
  }
  return out;
}

// ── Object keys ──────────────────────────────────────────────────────────────
// Layout: <prefix>/<table>/<year>/<name>-<table>-<label>-p<NNN>.<ext>
//         <prefix>/<table>/_index/<table>-<year>.jsonl
// Keys are unique and never reused, so a writer holding a no-delete token can only ADD.

/** Split on "/", drop blanks, rejoin — tolerates a prefix written "/archive/boost/". */
function joinKey(...segments: string[]): string {
  return segments.flatMap((s) => s.split("/")).filter(Boolean).join("/");
}

const partTag = (part: number): string => `p${String(part).padStart(3, "0")}`;

export interface KeyParts {
  prefix: string;
  name: string;
  table: string;
  week: IsoWeek;
  part: number;
  ext: string;
}

export function archiveObjectKey(k: KeyParts): string {
  const file = `${k.name}-${k.table}-${k.week.label}-${partTag(k.part)}.${k.ext}`;
  return joinKey(k.prefix, k.table, String(k.week.year), file);
}

export function manifestObjectKey(k: Omit<KeyParts, "ext">): string {
  return archiveObjectKey({ ...k, ext: "manifest.json" });
}

/**
 * The derived per-year index. It lives under _index/ — deliberately OUTSIDE the data folders
 * — because it is rewritten in place on every run (the read-modify-write that runlog.ts also
 * uses, since object stores have no append). It is a materialised view, never the truth: the
 * truth is the set of *.manifest.json objects, and --rebuild-index re-derives it from a listing.
 * That is also why the WORM lock must cover the data folders but NOT this prefix.
 */
export function indexObjectKey(k: { prefix: string; table: string; year: number }): string {
  return joinKey(k.prefix, k.table, "_index", `${k.table}-${k.year}.jsonl`);
}

// ── Set fingerprint ──────────────────────────────────────────────────────────

export interface Fingerprint {
  /** Row count in the window. */
  n: number;
  /** 16 lowercase hex chars — the 64-bit XOR of the leading 8 bytes of md5(id). */
  digest: string;
}

export function emptyFingerprint(): Fingerprint {
  return { n: 0, digest: "0000000000000000" };
}

const MASK64 = (1n << 64n) - 1n;

/** The per-id 64-bit value: first 8 bytes of md5(id-as-text) — matches Postgres exactly. */
function idValue(id: string): bigint {
  return BigInt(`0x${createHash("md5").update(id, "utf8").digest("hex").slice(0, 16)}`);
}

/** Order-independent XOR digest of a set of ids, as 16 zero-padded lowercase hex chars. */
export function xorDigest(ids: Iterable<string>): string {
  let x = 0n;
  for (const id of ids) x ^= idValue(id);
  return (x & MASK64).toString(16).padStart(16, "0");
}

/**
 * The SQL that computes the SAME fingerprint on the live table. Bound with psql variables
 * :start / :end so the caller never string-interpolates a timestamp. No ORDER BY: the digest
 * is order-independent, so Postgres is free to use whatever plan the time index gives it, and
 * memory stays constant regardless of how many rows the window holds.
 */
export function fingerprintSql(table: string, timeColumn: string): string {
  return (
    `SELECT count(*)::text || ' ' || ` +
    `coalesce(lpad(to_hex(bit_xor(('x' || substr(md5(id::text), 1, 16))::bit(64)::bigint)), 16, '0'), '0000000000000000') ` +
    `FROM ${table} WHERE ${timeColumn} >= :'start'::timestamptz AND ${timeColumn} < :'end'::timestamptz`
  );
}

// ── The other SQL the archiver issues ────────────────────────────────────────
// All of it is built here, as pure strings, so the safety-critical properties (half-open
// window, read-only session, id-list delete, LIMIT) are unit-testable without a database.
// Timestamps are ALWAYS bound through psql variables (:'start' / :'end'), never interpolated.

/** Session preamble for every READING connection — the pooler ignores PGOPTIONS, so this is the guard. */
export const READ_ONLY_PREAMBLE = "SET default_transaction_read_only = on;";

export function oldestRowSql(table: string, timeColumn: string): string {
  return `SELECT coalesce(to_char(min(${timeColumn}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') FROM ${table}`;
}

/**
 * The labels of any weeks holding rows BEHIND the pruned watermark — the "shouldn't happen" case,
 * found in a single query rather than by re-fingerprinting every historical week on every run.
 *
 * Postgres's IYYY/IW format codes are ISO-8601 week-numbering by definition, so this produces
 * exactly the same labels as isoWeekOf() — including the year-boundary behaviour where late
 * December falls in the next year's W01. `AT TIME ZONE 'UTC'` is what keeps the two in agreement:
 * without it the server's local timezone would silently decide the week boundaries.
 */
export function anomalousWeeksSql(table: string, timeColumn: string): string {
  return (
    `SELECT DISTINCT to_char(${timeColumn} AT TIME ZONE 'UTC', 'IYYY-"W"IW')` +
    ` FROM ${table} WHERE ${timeColumn} < :'watermark'::timestamptz ORDER BY 1`
  );
}

/**
 * The extract script fed to `psql -f`. Two choices carry it:
 *
 *   • UNALIGNED + TUPLES-ONLY rather than COPY. COPY's text format escapes every backslash, so a
 *     reader would have to un-escape before the NDJSON were valid — an easy thing to get subtly
 *     wrong on rows that carry raw webhook bodies. psql's unaligned output writes the value
 *     verbatim, and jsonb::text can never contain a raw newline (JSON escapes control characters),
 *     so one row really is one line.
 *   • FETCH_COUNT, so psql streams through a cursor instead of materialising the whole result set.
 *     Without it a multi-million-row window would be buffered in the client before a byte was written.
 */
export function extractSql(table: string, timeColumn: string, fetchCount = 1000): string {
  return [
    "\\set ON_ERROR_STOP on",
    "\\pset format unaligned",
    "\\pset tuples_only on",
    "\\pset footer off",
    // The SET's command tag would otherwise land in the NDJSON stream as a bare "SET" line, which
    // the fingerprint reader would (correctly) reject as malformed. Routing it to /dev/null is
    // deterministic in a way that relying on psql's -q quirks is not.
    "\\o /dev/null",
    READ_ONLY_PREAMBLE,
    "\\o",
    `\\set FETCH_COUNT ${fetchCount}`,
    `SELECT to_jsonb(t)::text FROM (SELECT * FROM ${table}` +
      ` WHERE ${timeColumn} >= :'start'::timestamptz AND ${timeColumn} < :'end'::timestamptz` +
      ` ORDER BY id) t;`,
    "",
  ].join("\n");
}

/**
 * One delete batch, returning how many rows it removed.
 *
 * Deliberately an id-list delete, never `DELETE … WHERE <timeColumn> < cutoff`. A predicate delete
 * would re-evaluate the window on every pass and could sweep in rows that arrived after the
 * fingerprint was checked; taking an explicit, ordered, LIMITed id set makes each batch a bounded,
 * inspectable unit. Small batches also matter because the table may sit in a realtime publication,
 * where one enormous delete floods the replication slot.
 */
export function deleteBatchSql(table: string, timeColumn: string, batchRows: number): string {
  return (
    `WITH victims AS (SELECT id FROM ${table}` +
    ` WHERE ${timeColumn} >= :'start'::timestamptz AND ${timeColumn} < :'end'::timestamptz` +
    ` ORDER BY id LIMIT ${batchRows}),` +
    ` deleted AS (DELETE FROM ${table} t USING victims v WHERE t.id = v.id RETURNING 1)` +
    ` SELECT count(*)::text FROM deleted`
  );
}

/**
 * Streaming fingerprint accumulator over NDJSON. Feed it chunks; it counts rows and XORs ids.
 *
 * The fast path matches `{"id":"…"` at the head of the line, because to_jsonb() emits keys in
 * column order and `id` is first — but it FALLS BACK to JSON.parse rather than trusting that,
 * so a table with a different column order stays correct instead of silently digesting nothing.
 *
 * A line that parses as neither is a hard error. That matters more than it looks: a psql stream
 * killed mid-row is precisely the CB-194 failure class, and a scanner that shrugged at a partial
 * final line would report a short count as a clean success — and the prune would then delete
 * rows that were never written.
 */
const FAST_ID = /^\{"id":"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;

export class FingerprintAccumulator {
  private x = 0n;
  private count = 0;
  private pending = "";

  /** Feed a chunk of NDJSON text. Lines may straddle chunk boundaries. */
  push(chunk: string): void {
    this.pending += chunk;
    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      this.line(this.pending.slice(0, nl));
      this.pending = this.pending.slice(nl + 1);
    }
  }

  private line(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return; // tolerate blank/trailing lines
    const fast = FAST_ID.exec(line);
    if (fast) {
      this.x ^= idValue(fast[1]);
      this.count++;
      return;
    }
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`malformed NDJSON: could not parse a row (${line.length} chars, starts "${line.slice(0, 24)}")`);
    }
    const id = (row as { id?: unknown })?.id;
    if (typeof id !== "string") throw new Error("malformed NDJSON: a row has no string `id`");
    this.x ^= idValue(id);
    this.count++;
  }

  /** Flush any unterminated trailing line and return the fingerprint. */
  finish(): Fingerprint {
    if (this.pending !== "") {
      const tail = this.pending;
      this.pending = "";
      this.line(tail); // throws if the stream died mid-row
    }
    return { n: this.count, digest: (this.x & MASK64).toString(16).padStart(16, "0") };
  }
}

/** Whole-string convenience wrapper around FingerprintAccumulator (tests, small inputs). */
export function fingerprintOf(ndjson: string): Fingerprint {
  const acc = new FingerprintAccumulator();
  acc.push(ndjson);
  return acc.finish();
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.n === b.n && a.digest === b.digest;
}

// ── Dry-run levels ───────────────────────────────────────────────────────────

/**
 * Two nested levels of suppression, named for what they hold back:
 *
 *   none    — production: read, write the archive, delete the rows.
 *   source  — no writes to the SOURCE database. The archive is really built, really uploaded
 *             and really verified; the rows simply stay put.
 *   store   — no writes to the store either. Artifacts are built and verified locally and
 *             left for inspection.
 *
 * `store` IMPLIES `source`, and that is a safety invariant rather than a convenience: deleting
 * rows that were never durably stored is the one unrecoverable failure in this system, so there
 * is deliberately no combination of flags that can delete without having written.
 */
export type DryRun = "none" | "source" | "store";

export interface RunGuards {
  mayWriteStore: boolean;
  mayDeleteRows: boolean;
}

export function parseDryRun(spec: string | undefined): DryRun {
  const s = spec ?? "none";
  if (s === "none" || s === "source" || s === "store") return s;
  throw new Error(`invalid --dry-run "${spec}" — expected "none", "source" or "store"`);
}

export function guardsFor(level: DryRun): RunGuards {
  return {
    mayWriteStore: level === "none" || level === "source",
    mayDeleteRows: level === "none",
  };
}

// ── Part / prune state machine ───────────────────────────────────────────────

export type PartRole = "full" | "superseded" | "supplement";

export interface ArchivedPart {
  part: number;
  role: PartRole;
  rowCount: number;
  fingerprint: Fingerprint;
}

export interface WeekState {
  label: string;
  state: "archived" | "pruned";
  parts: ArchivedPart[];
}

/**
 * The part that currently represents the whole window: the highest-numbered `full` part.
 * Supplements are additive extras recorded after a prune and are deliberately NOT "active" —
 * they describe rows that arrived late, not a snapshot of the window.
 */
export function activePart(parts: ArchivedPart[]): ArchivedPart | undefined {
  return parts.filter((p) => p.role === "full").sort((a, b) => b.part - a.part)[0];
}

const maxPart = (parts: ArchivedPart[]): number => parts.reduce((m, p) => Math.max(m, p.part), 0);

export interface ArchivePlan {
  action: "archive" | "supersede" | "supplement" | "skip";
  part?: number;
  role?: PartRole;
  supersedes?: number[];
  anomaly?: boolean;
  reason?: string;
}

/**
 * What to write for a week, given what the store already holds and what is live in the DB.
 * Objects are NEVER overwritten, so every outcome is either "nothing" or "a new part".
 *
 * The discriminator is whether the week was already pruned:
 *   • not pruned + fingerprint drifted → the window changed before we deleted anything.
 *     Re-archive the FULL window as a new part and mark the old one superseded. No set
 *     subtraction, no decryption — just a fresh, complete snapshot.
 *   • pruned + live rows exist → everything else in that window was deleted, so whatever is
 *     there now is by definition new. Archive it as a supplement and flag it: this is the
 *     "shouldn't happen" case (created_at defaults to now(), so it implies a back-dated
 *     insert or a partial prune) and it should reach a human.
 */
export function planArchive(state: WeekState | undefined, live: Fingerprint): ArchivePlan {
  if (!state) return { action: "archive", part: 1, role: "full" };

  if (state.state === "pruned") {
    if (live.n === 0) return { action: "skip", reason: "already pruned" };
    return { action: "supplement", part: maxPart(state.parts) + 1, role: "supplement", anomaly: true };
  }

  const active = activePart(state.parts);
  if (active && sameFingerprint(active.fingerprint, live)) {
    return { action: "skip", reason: "already archived" };
  }
  return {
    action: "supersede",
    part: maxPart(state.parts) + 1,
    role: "full",
    supersedes: state.parts.filter((p) => p.role === "full").map((p) => p.part),
  };
}

export interface PrunePlan {
  action: "prune" | "refuse" | "skip";
  expectRows?: number;
  part?: number;
  reason?: string;
}

/**
 * Whether a week may be deleted from the source. This is the gate the whole design hangs on:
 * it compares the LIVE fingerprint, recomputed moments before the delete, against the one
 * recorded when the object was written and verified. Any drift refuses outright — a partial
 * or best-effort delete is never an option, because the rows it removed would be unrecoverable.
 */
/**
 * The stored-object half of the prune gate: which object to re-read before deleting a week, and
 * the SHA-256 it must still have. Pure, so every refusal path is testable without a store.
 *
 * planPrune() only compares the LIVE table against the manifest — it says nothing about whether the
 * archive is still intact. The object IS hash-verified when written, but a week is pruned
 * `prune-after-weeks − archive-after-weeks` later (9 weeks apart in Boost's profile), so in the
 * steady state prune always acts on an object last verified many runs earlier. Without this, an
 * object that rotted, was truncated, or was tampered with after archiving is deleted from the
 * database anyway — the one unrecoverable mistake this tool can make.
 *
 * Every failure answers `error`, never "no hash recorded, carry on": a manifest we cannot read is
 * not evidence that the archive is good. A legacy manifest predating `objectSha256` therefore
 * BLOCKS its week's prune until it is re-archived, which is the safe direction to fail.
 */
export function parsePruneManifest(
  text: string | null,
  expectPart: number,
): { objectKey: string; objectSha256: string } | { nothingToVerify: true } | { error: string } {
  if (text === null) return { error: "manifest object is missing from the store" };
  if (!text.trim()) return { error: "manifest object is empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "manifest is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "manifest is not a JSON object" };
  }
  const m = parsed as Record<string, unknown>;

  if (typeof m.part !== "number") return { error: "manifest records no part number" };
  if (m.part !== expectPart) return { error: `manifest is for part ${m.part}, expected part ${expectPart}` };

  if (typeof m.rowCount !== "number" || !Number.isFinite(m.rowCount)) {
    return { error: "manifest records no rowCount" };
  }

  const objectKey = typeof m.objectKey === "string" ? m.objectKey.trim() : "";

  // A zero-row week writes no data object at all (objectKey/objectSha256 are null by design), so
  // there is nothing to re-read — and nothing to lose, since the delete removes no rows. This is
  // gated on rowCount being genuinely 0, NOT merely on the key being absent: a manifest for a
  // non-empty week that has lost its key must refuse, not silently waive the check.
  if (m.rowCount === 0 && !objectKey) return { nothingToVerify: true };

  if (!objectKey) return { error: "manifest records no objectKey" };

  const objectSha256 = typeof m.objectSha256 === "string" ? m.objectSha256.trim() : "";
  if (!objectSha256) return { error: "manifest records no objectSha256 — re-archive this week before pruning it" };

  return { objectKey, objectSha256 };
}

export function planPrune(state: WeekState | undefined, live: Fingerprint): PrunePlan {
  if (!state) return { action: "refuse", reason: "no archive exists for this week" };
  if (state.state === "pruned") return { action: "skip", reason: "already pruned" };

  const active = activePart(state.parts);
  if (!active) return { action: "refuse", reason: "no archive part covers this week" };

  if (active.fingerprint.n !== live.n) {
    return {
      action: "refuse",
      reason: `row count drifted since archiving (archived ${active.fingerprint.n}, live ${live.n})`,
    };
  }
  if (active.fingerprint.digest !== live.digest) {
    return {
      action: "refuse",
      reason: `id digest drifted since archiving (archived ${active.fingerprint.digest}, live ${live.digest})`,
    };
  }
  return { action: "prune", expectRows: active.rowCount, part: active.part };
}
