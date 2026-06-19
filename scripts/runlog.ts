// ─────────────────────────────────────────────────────────────────────────────
// Append a record to the private R2 run-log (the dashboard's system-of-record).
//
//   tsx runlog.ts run    --ts ISO --ok true|false [--tiers "2hourly daily"] [--bytes N] [--key K] [--error MSG]
//   tsx runlog.ts verify --ts ISO --verified-ts ISO --ok true|false [--ratio R]
//
// Records land in _log/<FILE_BASENAME>/{runs,verifications}-YYYY-MM.jsonl in R2.
// "Append" = read-modify-write of the CURRENT month's file (S3/R2 has no native
// append): monthly partitioning rotates the file by name (prior months freeze);
// an R2 lifecycle rule on _log/ expires old months. Everything is BEST-EFFORT —
// any failure logs a warning and exits 0 so a logging hiccup never fails a backup.
//
// Reads from the environment: R2_BUCKET, FILE_BASENAME, the RCLONE_CONFIG_R2_*
// rclone remote (set by the calling backup/drill script), and the GitHub default
// vars GITHUB_RUN_ID / GITHUB_SERVER_URL / GITHUB_REPOSITORY (for run links).
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function main(): void {
  const [kind, ...rest] = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith("--")) continue;
    flags[k.slice(2)] = rest[i + 1] ?? "";
  }

  const remote = process.env.RUNLOG_RCLONE_REMOTE ?? "r2";
  const bucket = process.env.R2_BUCKET;
  const basename = process.env.FILE_BASENAME;
  if (!bucket || !basename) {
    warn("R2_BUCKET / FILE_BASENAME not set — skipping run-log");
    return;
  }

  const runId = process.env.GITHUB_RUN_ID || null;
  const runUrl =
    runId && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
      : null;

  const ts = flags.ts || new Date().toISOString();
  const ym = ts.slice(0, 7); // "YYYY-MM" from an ISO stamp

  let fileBase: string;
  let record: LogRun | LogVerification;
  if (kind === "run") {
    fileBase = "runs";
    const tiers = (flags.tiers ?? "").split(/\s+/).filter(Boolean) as BackupTier[];
    record = {
      ts,
      ok: flags.ok === "true",
      tiers,
      bytes: flags.bytes ? Number(flags.bytes) : null,
      key: flags.key || null,
      runId,
      runUrl,
      error: flags.error || null,
    } satisfies LogRun;
  } else if (kind === "verify") {
    fileBase = "verifications";
    record = {
      ts,
      verifiedTs: flags["verified-ts"] || ts,
      ok: flags.ok === "true",
      ratio: flags.ratio ? Number(flags.ratio) : null,
      runId,
      runUrl,
    } satisfies LogVerification;
  } else {
    warn(`unknown kind '${kind ?? ""}' (expected 'run' or 'verify')`);
    return;
  }

  const fileName = `${fileBase}-${ym}.jsonl`;
  const dirPath = `${remote}:${bucket}/_log/${basename}/`;
  const objPath = `${remote}:${bucket}/_log/${basename}/${fileName}`;

  // List first so we can tell "file genuinely absent" (→ start fresh) from "R2
  // unreachable" (→ skip, don't risk clobbering history with a truncated write).
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

  const tmp = join(tmpdir(), `runlog-${process.pid}-${ym}.jsonl`);
  writeFileSync(tmp, body);
  // copyto (a sized PUT) rather than rcat (a stdin stream): R2 rejects rcat's
  // streaming-signature upload — same reason the Slack state-save uses copyto.
  const put = rclone(["copyto", tmp, objPath, "--s3-no-check-bucket"]);
  try {
    unlinkSync(tmp);
  } catch {
    /* temp cleanup is best-effort */
  }
  if (!put.ok) {
    warn("failed to write the run-log back to R2");
    return;
  }
  process.stdout.write(`runlog: appended ${kind} → _log/${basename}/${fileName}\n`);
}

main();
