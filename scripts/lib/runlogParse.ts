// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers over the private run-log's on-disk shape (_log/<name>/runs-YYYY-MM.jsonl).
//
// Node-free so the Cloudflare Worker's watchdog can bundle them and read the run-log through its
// R2 binding with the same tolerance the Actions-side scripts have. runlog.ts re-exports them.
// ─────────────────────────────────────────────────────────────────────────────

/** The fields the watchdog reads from a run record; the full shape is LogRun in backupTypes.ts. */
export interface RunRecordLike {
  ts: string;
  ok?: boolean;
  error?: string | null;
  errorCode?: string | null;
}

/** "YYYY-MM" for a Date, in UTC — the run-log's partition key (records are stamped in UTC). */
export function runlogMonthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The object key of a month's run partition. */
export const runlogKey = (basename: string, ym: string): string => `_log/${basename}/runs-${ym}.jsonl`;

/**
 * The partitions a "latest run" reader should try, newest first: the current month, then the previous
 * one — so a failure in the first minutes of a month still resolves.
 */
export function runlogMonthsToTry(now: Date): string[] {
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [runlogMonthKey(now), runlogMonthKey(prevMonth)];
}

/**
 * Newest valid record in a runs-*.jsonl body. Pure, so the awkward parts are testable without R2:
 * a torn final line (read-modify-write means the last line can be partial) must not discard the
 * whole partition, and the newest record is chosen by `ts` rather than by position, so an
 * out-of-order append can't win.
 */
export function pickLatestRun<T extends RunRecordLike = RunRecordLike>(body: string): T | null {
  const records = (body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((r): r is T => !!r && typeof r === "object" && !Array.isArray(r) && typeof r.ts === "string");
  if (!records.length) return null;
  records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return records[records.length - 1];
}
