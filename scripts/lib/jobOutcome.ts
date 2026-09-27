// ─────────────────────────────────────────────────────────────────────────────
// The per-run OUTCOME record — what a job leaves behind for the scheduler Worker to announce.
//
// Jobs no longer talk to Slack. Every run of backup / durable-verify / restore-drill / archive writes
// one of these to its client's PRIVATE bucket as it exits (lib/outcomeRecorder.ts), then its workflow's
// last step tells the Worker it finished (POST /notify, authenticated by GitHub OIDC). The Worker reads
// the record through its R2 binding and renders every Slack message itself, with the one Slack token
// it alone holds (scheduler/src/deliver.ts). A notify that never arrives is caught by the Worker's
// reconcile tick, which lists this prefix.
//
// One flat, time-sortable prefix per bucket — `_status/_outcome/<stamp>_<run>_<attempt>_<job>_<name>.json`
// — so one `list({ prefix, startAfter })` finds a run's record without knowing its profile name, and
// the bucket's existing 14-day `_status/` lifecycle rule expires them.
//
// Node-free and env-free: bundled into the Worker, which parses records with parseJobOutcome().
// ─────────────────────────────────────────────────────────────────────────────

import type { RunOrigin } from "./runOrigin.js";

export const OUTCOME_VERSION = 1;
export const OUTCOME_PREFIX = "_status/_outcome/";

export const OUTCOME_JOBS = ["backup", "durableVerify", "restoreDrill", "archive"] as const;
export type OutcomeJob = (typeof OUTCOME_JOBS)[number];

/** `page` mentions the channel (a human must act); `warn` is a quiet note. */
export type Severity = "page" | "warn";

export interface OutcomeAlert {
  severity: Severity;
  /** Machine-readable cause, `[a-z0-9_]{1,40}` — e.g. `restore_failed`, `config_invalid`, `exit_143`. */
  code: string;
  /** Human reason. UNTRUSTED as far as the Worker is concerned: it is escaped and code-spanned there. */
  text: string;
}

export interface ArchiveTableSummary {
  table: string;
  weeksArchived: number;
  rowsArchived: number;
  weeksPruned: number;
  rowsPruned: number;
}

export type OutcomeSummary =
  | { kind: "backup"; tiers: string[]; bytes: number | null }
  | { kind: "durableVerify"; objects: number; hashes: number; restores: number }
  | { kind: "restoreDrill"; table: string; count: number | null; ratio: number | null; key: string }
  | { kind: "archive"; dryRun: string; tables: ArchiveTableSummary[] };

export interface JobOutcome {
  version: typeof OUTCOME_VERSION;
  /** `job` = written by the job itself; `github` = synthesised by the Worker from the Actions API. */
  source: "job" | "github";
  job: OutcomeJob;
  /** Profile `name` — the Slack header, the daily row's state object. */
  name: string;
  runId: string;
  runAttempt: number;
  /** The job's check-run id (= its job id), for the per-job log link; null when unknown. */
  jobId: string | null;
  ok: boolean;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** backup only: how the run was started (the row's 🖐️ / 🩹 marker). */
  origin: RunOrigin | null;
  summary: OutcomeSummary | null;
  alerts: OutcomeAlert[];
}

export const MAX_ALERTS = 20;
export const MAX_ALERT_TEXT = 2000;

const DIGITS = /^\d{1,20}$/;
const CODE = /^[a-z0-9_]{1,40}$/;
// A profile name becomes part of an object key and a Slack header — no separators, no markup.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIER = /^[a-z0-9]{1,20}$/;
const ORIGINS: readonly RunOrigin[] = ["schedule", "manual", "self-heal"];

export const isOutcomeJob = (s: unknown): s is OutcomeJob => typeof s === "string" && (OUTCOME_JOBS as readonly string[]).includes(s);
export const isOutcomeName = (s: unknown): s is string => typeof s === "string" && NAME.test(s);

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYYMMDDTHHMMSSZ` (UTC) for an ISO instant — sorts lexically in time order. "" when unparseable. */
export function outcomeStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** The record's object key. Throws on an identity that cannot form a safe key — callers validate first. */
export function outcomeKey(o: Pick<JobOutcome, "startedAt" | "runId" | "runAttempt" | "job" | "name">): string {
  const stamp = outcomeStamp(o.startedAt);
  if (!stamp || !DIGITS.test(o.runId) || !Number.isInteger(o.runAttempt) || o.runAttempt < 1 || !isOutcomeJob(o.job) || !isOutcomeName(o.name)) {
    throw new Error(`cannot build an outcome key for ${JSON.stringify({ ...o })}`);
  }
  return `${OUTCOME_PREFIX}${stamp}_${o.runId}_${o.runAttempt}_${o.job}_${o.name}.json`;
}

export interface OutcomeKeyParts {
  stamp: string;
  runId: string;
  runAttempt: number;
  job: OutcomeJob;
  name: string;
}

/** Inverse of outcomeKey(); null for anything else under the prefix. */
export function parseOutcomeKey(key: string): OutcomeKeyParts | null {
  if (!key.startsWith(OUTCOME_PREFIX) || !key.endsWith(".json")) return null;
  const parts = key.slice(OUTCOME_PREFIX.length, -".json".length).split("_");
  if (parts.length < 5) return null;
  const [stamp, runId, attempt, job, ...rest] = parts;
  const name = rest.join("_"); // a profile name may itself contain "_"
  const runAttempt = Number(attempt);
  if (!/^\d{8}T\d{6}Z$/.test(stamp) || !DIGITS.test(runId) || !DIGITS.test(attempt) || runAttempt < 1) return null;
  if (!isOutcomeJob(job) || !isOutcomeName(name)) return null;
  return { stamp, runId, runAttempt, job, name };
}

/** The key-infix a run's records share: `_<runId>_<attempt>_<job>_`. */
export const outcomeRunInfix = (runId: string, runAttempt: number, job: OutcomeJob): string => `_${runId}_${runAttempt}_${job}_`;

/** `startAfter` for a listing of records started at or after `sinceMs`. */
export function outcomeStartAfter(sinceMs: number): string {
  return `${OUTCOME_PREFIX}${outcomeStamp(new Date(sinceMs).toISOString())}`;
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const numOrNull = (v: unknown): number | null => (isFiniteNum(v) ? v : null);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

function parseSummary(job: OutcomeJob, v: unknown): OutcomeSummary | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const s = v as Record<string, unknown>;
  if (s.kind !== job) return undefined; // a summary must describe the job the record is for
  switch (job) {
    case "backup": {
      if (!Array.isArray(s.tiers) || s.tiers.length > 8 || !s.tiers.every((t) => typeof t === "string" && TIER.test(t))) return undefined;
      return { kind: "backup", tiers: s.tiers as string[], bytes: numOrNull(s.bytes) };
    }
    case "durableVerify": {
      if (!isNonNegInt(s.objects) || !isNonNegInt(s.hashes) || !isNonNegInt(s.restores)) return undefined;
      return { kind: "durableVerify", objects: s.objects, hashes: s.hashes, restores: s.restores };
    }
    case "restoreDrill": {
      const table = str(s.table, 200);
      const key = str(s.key, 500);
      if (table === null || key === null) return undefined;
      return { kind: "restoreDrill", table, count: numOrNull(s.count), ratio: numOrNull(s.ratio), key };
    }
    case "archive": {
      const dryRun = str(s.dryRun, 20);
      if (dryRun === null || !Array.isArray(s.tables) || s.tables.length > 50) return undefined;
      const tables: ArchiveTableSummary[] = [];
      for (const t of s.tables as unknown[]) {
        if (!t || typeof t !== "object") return undefined;
        const r = t as Record<string, unknown>;
        const table = str(r.table, 200);
        if (table === null) return undefined;
        if (![r.weeksArchived, r.rowsArchived, r.weeksPruned, r.rowsPruned].every(isNonNegInt)) return undefined;
        tables.push({
          table,
          weeksArchived: r.weeksArchived as number,
          rowsArchived: r.rowsArchived as number,
          weeksPruned: r.weeksPruned as number,
          rowsPruned: r.rowsPruned as number,
        });
      }
      return { kind: "archive", dryRun, tables };
    }
  }
}

/**
 * Parse a stored record, strictly: the Worker renders from it, and the only thing that can write it is
 * whoever holds the bucket's CI key. Anything off-shape → null (the Worker marks it invalid, posts nothing).
 */
export function parseJobOutcome(raw: string): JobOutcome | null {
  if (!raw || raw.length > 256 * 1024) return null;
  let v: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    v = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (v.version !== OUTCOME_VERSION) return null;
  if (v.source !== "job" && v.source !== "github") return null;
  if (!isOutcomeJob(v.job) || !isOutcomeName(v.name)) return null;
  if (typeof v.runId !== "string" || !DIGITS.test(v.runId)) return null;
  if (!Number.isInteger(v.runAttempt) || (v.runAttempt as number) < 1) return null;
  if (v.jobId !== null && (typeof v.jobId !== "string" || !DIGITS.test(v.jobId))) return null;
  if (typeof v.ok !== "boolean" || !Number.isInteger(v.exitCode)) return null;
  const startedAt = str(v.startedAt, 40);
  const finishedAt = str(v.finishedAt, 40);
  if (!startedAt || !finishedAt || !outcomeStamp(startedAt) || !outcomeStamp(finishedAt)) return null;
  if (!isNonNegInt(v.durationMs)) return null;
  if (v.origin !== null && !(ORIGINS as readonly unknown[]).includes(v.origin)) return null;
  const summary = parseSummary(v.job, v.summary);
  if (summary === undefined) return null;
  if (!Array.isArray(v.alerts) || v.alerts.length > MAX_ALERTS) return null;
  const alerts: OutcomeAlert[] = [];
  for (const a of v.alerts as unknown[]) {
    if (!a || typeof a !== "object") return null;
    const r = a as Record<string, unknown>;
    if (r.severity !== "page" && r.severity !== "warn") return null;
    if (typeof r.code !== "string" || !CODE.test(r.code)) return null;
    const text = str(r.text, MAX_ALERT_TEXT);
    if (text === null) return null;
    alerts.push({ severity: r.severity, code: r.code, text });
  }
  return {
    version: OUTCOME_VERSION,
    source: v.source,
    job: v.job,
    name: v.name,
    runId: v.runId,
    runAttempt: v.runAttempt as number,
    jobId: (v.jobId as string | null) ?? null,
    ok: v.ok,
    exitCode: v.exitCode as number,
    startedAt,
    finishedAt,
    durationMs: v.durationMs,
    origin: (v.origin as RunOrigin | null) ?? null,
    summary,
    alerts,
  };
}

/** Clamp an alert to what parseJobOutcome() accepts, so a writer can never produce a record the Worker rejects. */
export function clampAlert(a: OutcomeAlert): OutcomeAlert {
  const code = a.code.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) || "unknown";
  const text = a.text.length > MAX_ALERT_TEXT ? `${a.text.slice(0, MAX_ALERT_TEXT - 1)}…` : a.text;
  return { severity: a.severity, code, text };
}
