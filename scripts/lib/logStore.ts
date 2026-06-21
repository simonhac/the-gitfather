// ─────────────────────────────────────────────────────────────────────────────
// Shared in-memory log store. Loads the whole private run/verification history
// (_log/<basename>/{runs,verifications}-YYYY-MM.jsonl) into typed arrays + Map
// indexes, so consumers join by plain lookup instead of targeted rclone cat.
//
// Used by build-dashboard.ts (the grid), restore-drill-pg.ts (the drift gate), and
// verify-durable-pg.ts (the due-set). Working set is tiny — bounded by the _log/
// lifecycle expiry — so loading everything is cheap (R2 egress is free).
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRun, LogVerification } from "./backupTypes.js";

export interface RawLog {
  runs: LogRun[];
  verifications: LogVerification[];
}

export interface LogStore extends RawLog {
  /** Compact dump stamp (YYYYMMDDTHHMMSSZ) → its run. */
  runByStamp: Map<string, LogRun>;
  /** Object key → its run. */
  runByKey: Map<string, LogRun>;
  /** Object key → verifications recorded against that exact key. */
  verifyByKey: Map<string, LogVerification[]>;
  /** Compact dump stamp → verifications (legacy join when a record lacks a key). */
  verifyByStamp: Map<string, LogVerification[]>;
}

/** The compact UTC stamp embedded in object keys, e.g. "20260620T160000Z" (null if none). */
export function stampFromKey(key: string): string | null {
  return key.match(/[0-9]{8}T[0-9]{6}Z/)?.[0] ?? null;
}

/** ISO stamp (2026-06-20T16:00:00Z) → compact (20260620T160000Z). */
export function compactStamp(iso: string): string {
  return iso.replace(/[-:]/g, "");
}

/** Parse a directory of *.jsonl into runs + verifications (skips malformed lines). */
export function readLogDir(dir: string): RawLog {
  const runs: LogRun[] = [];
  const verifications: LogVerification[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { runs, verifications };
  }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(dir, f), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln);
        if (f.startsWith("runs-")) runs.push(o as LogRun);
        else if (f.startsWith("verifications-")) verifications.push(o as LogVerification);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return { runs, verifications };
}

/** rclone-copy every _log/<basename>/*.jsonl to a tmpdir and parse it. Uses the `r2` remote. */
export function downloadLogsFromR2(bucket: string, basename: string): RawLog {
  const dest = mkdtempSync(join(tmpdir(), "pg-log-"));
  execFileSync(
    "rclone",
    ["copy", `r2:${bucket}/_log/${basename}/`, dest, "--include", "*.jsonl", "--s3-no-check-bucket"],
    { stdio: "inherit" },
  );
  return readLogDir(dest);
}

/** Build the Map indexes over a parsed log. */
export function indexLog(raw: RawLog): LogStore {
  const runByStamp = new Map<string, LogRun>();
  const runByKey = new Map<string, LogRun>();
  for (const r of raw.runs) {
    if (r.ts) runByStamp.set(compactStamp(r.ts), r);
    if (r.key) runByKey.set(r.key, r);
  }
  const verifyByKey = new Map<string, LogVerification[]>();
  const verifyByStamp = new Map<string, LogVerification[]>();
  const push = (m: Map<string, LogVerification[]>, k: string, v: LogVerification): void => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  for (const v of raw.verifications) {
    if (v.key) push(verifyByKey, v.key, v);
    if (v.verifiedTs) push(verifyByStamp, compactStamp(v.verifiedTs), v);
  }
  return { ...raw, runByStamp, runByKey, verifyByKey, verifyByStamp };
}

/**
 * Load + index the whole log from R2 using env R2_BUCKET / FILE_BASENAME (the caller must have
 * already configured the RCLONE_CONFIG_R2_* remote, as the drill/verify scripts do).
 */
export function loadLog(): LogStore {
  const bucket = process.env.R2_BUCKET;
  const basename = process.env.FILE_BASENAME;
  if (!bucket || !basename) throw new Error("R2_BUCKET / FILE_BASENAME must be set to load the run-log");
  return indexLog(downloadLogsFromR2(bucket, basename));
}
