// ─────────────────────────────────────────────────────────────────────────────
// Append a record to the private R2 run-log (the dashboard's system-of-record).
//
// Importable API (used in-process by the ported backup/drill scripts):
//   appendRun({ ts, ok, tiers, bytes?, key?, error? })
//   appendVerify({ ts, verifiedTs, ok, ratio? })
//
// CLI (kept for back-compat / direct use):
//   tsx runlog.ts run    --ts ISO --ok true|false [--tiers "2hourly daily"] [--bytes N] [--key K] [--error MSG]
//   tsx runlog.ts verify --ts ISO --verified-ts ISO --ok true|false [--ratio R]
//
// Records land in _log/<FILE_BASENAME>/{runs,verifications}-YYYY-MM.jsonl in R2.
// "Append" = read-modify-write of the CURRENT month's file (S3/R2 has no native
// append): monthly partitioning rotates the file by name (prior months freeze);
// an R2 lifecycle rule on _log/ expires old months. Everything is BEST-EFFORT —
// any failure logs a warning and returns (never throws) so a logging hiccup never
// fails a backup.
//
// Reads from the environment: R2_BUCKET, FILE_BASENAME, the RCLONE_CONFIG_R2_*
// rclone remote (set by the calling backup/drill script), and the GitHub default
// vars GITHUB_RUN_ID / GITHUB_SERVER_URL / GITHUB_REPOSITORY (for run links).
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LogRun, LogVerification, BackupTier } from "./lib/backupTypes.js";

function warn(msg: string): void {
  process.stderr.write(`runlog: ${msg}\n`);
}

function rclone(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("rclone", args, { encoding: "utf8" }) };
  } catch (e) {
    const err = e as { stdout?: Buffer | string };
    return { ok: false, out: err.stdout ? err.stdout.toString() : "" };
  }
}

function githubRunInfo(): { runId: string | null; runUrl: string | null } {
  const runId = process.env.GITHUB_RUN_ID || null;
  const runUrl =
    runId && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
      : null;
  return { runId, runUrl };
}

/**
 * Best-effort read-modify-write of the current month's jsonl in R2. Lists first so we can
 * tell "file genuinely absent" (→ start fresh) from "R2 unreachable" (→ skip, don't risk
 * clobbering history with a truncated write). Never throws.
 */
function appendRecord(fileBase: "runs" | "verifications", ts: string, record: LogRun | LogVerification): void {
  const remote = process.env.RUNLOG_RCLONE_REMOTE ?? "r2";
  const bucket = process.env.R2_BUCKET;
  const basename = process.env.FILE_BASENAME;
  if (!bucket || !basename) {
    warn("R2_BUCKET / FILE_BASENAME not set — skipping run-log");
    return;
  }

  const ym = ts.slice(0, 7); // "YYYY-MM" from an ISO stamp
  const fileName = `${fileBase}-${ym}.jsonl`;
  const dirPath = `${remote}:${bucket}/_log/${basename}/`;
  const objPath = `${remote}:${bucket}/_log/${basename}/${fileName}`;

  const ls = rclone(["lsf", "--files-only", dirPath, "--s3-no-check-bucket"]);
  if (!ls.ok) {
    warn("cannot reach R2 to read the run-log — skipping this append");
    return;
  }
  let existing = "";
  if (ls.out.split("\n").map((s) => s.trim()).includes(fileName)) {
    const cat = rclone(["cat", objPath, "--s3-no-check-bucket"]);
    if (!cat.ok) {
      warn("current month's run-log is unreadable — skipping to avoid clobber");
      return;
    }
    existing = cat.out;
  }

  const line = JSON.stringify(record);
  const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  const body = `${prefix}${line}\n`;

  // copyto (a sized PUT) rather than rcat (a stdin stream): R2 rejects rcat's streaming-
  // signature upload. The whole stage-and-upload is wrapped so a tmp-write hiccup can never
  // throw — appendRun/appendVerify must be best-effort (the drill calls appendVerify directly).
  const tmp = join(tmpdir(), `runlog-${process.pid}-${ym}.jsonl`);
  let put: { ok: boolean; out: string };
  try {
    writeFileSync(tmp, body);
    put = rclone(["copyto", tmp, objPath, "--s3-no-check-bucket"]);
  } catch (e) {
    warn(`failed to stage the run-log locally: ${(e as Error).message}`);
    return;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp cleanup is best-effort */
    }
  }
  if (!put.ok) {
    warn("failed to write the run-log back to R2");
    return;
  }
  process.stdout.write(`runlog: appended ${fileBase === "runs" ? "run" : "verify"} → _log/${basename}/${fileName}\n`);
}

export interface RunRecordInput {
  /** ISO-8601 UTC stamp of the dump. */
  ts: string;
  ok: boolean;
  /** Tiers promoted to (always includes "2hourly" on success; [] on failure). */
  tiers: BackupTier[];
  bytes?: number | null;
  key?: string | null;
  /** Raw failure reason — PRIVATE only, never published. */
  error?: string | null;
}

/** Append a run record to the private R2 run-log. Best-effort (never throws). */
export function appendRun(input: RunRecordInput): void {
  const { runId, runUrl } = githubRunInfo();
  const record: LogRun = {
    ts: input.ts,
    ok: input.ok,
    tiers: input.tiers,
    bytes: input.bytes ?? null,
    key: input.key ?? null,
    runId,
    runUrl,
    error: input.error ?? null,
  };
  appendRecord("runs", input.ts, record);
}

export interface VerifyRecordInput {
  ts: string;
  /** The dump stamp the drill restored & verified (matches a run's ts). */
  verifiedTs: string;
  ok: boolean;
  ratio?: number | null;
}

/** Append a verification record to the private R2 run-log. Best-effort (never throws). */
export function appendVerify(input: VerifyRecordInput): void {
  const { runId, runUrl } = githubRunInfo();
  const record: LogVerification = {
    ts: input.ts,
    verifiedTs: input.verifiedTs || input.ts,
    ok: input.ok,
    ratio: input.ratio ?? null,
    runId,
    runUrl,
  };
  appendRecord("verifications", input.ts, record);
}

// ── CLI entrypoint (back-compat) ─────────────────────────────────────────────
function main(): void {
  const [kind, ...rest] = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith("--")) continue;
    flags[k.slice(2)] = rest[i + 1] ?? "";
  }

  const ts = flags.ts || new Date().toISOString();
  if (kind === "run") {
    appendRun({
      ts,
      ok: flags.ok === "true",
      tiers: (flags.tiers ?? "").split(/\s+/).filter(Boolean) as BackupTier[],
      bytes: flags.bytes ? Number(flags.bytes) : null,
      key: flags.key || null,
      error: flags.error || null,
    });
  } else if (kind === "verify") {
    appendVerify({
      ts,
      verifiedTs: flags["verified-ts"] || ts,
      ok: flags.ok === "true",
      ratio: flags.ratio ? Number(flags.ratio) : null,
    });
  } else {
    warn(`unknown kind '${kind ?? ""}' (expected 'run' or 'verify')`);
  }
}

// Run main() only when invoked directly (not when imported by backup/drill).
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint()) main();
