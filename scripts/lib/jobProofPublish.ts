// ─────────────────────────────────────────────────────────────────────────────
// Publish a job proof to R2 (Actions-side, rclone) — see jobProof.ts for what a proof claims and
// who reads it. Same shape as watchdogPublish.ts. Best-effort: a failed publish warns and never
// fails the job — the Worker's /health/jobs then reports the proof stale, which is the right answer
// if proofs are not landing.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./proc.js";
import { jobProof, jobProofKey, type ProofJob } from "./jobProof.js";

/**
 * Write `_health/<name>/<job>.json` to `bucket` (RCLONE_CONFIG_R2_* already set). The remote honours
 * RUNLOG_RCLONE_REMOTE like the run-log it sits beside, so the alias-backend integration test can
 * drive the real write path.
 */
export function publishJobProof(opts: { bucket: string | undefined; name: string | undefined; job: ProofJob; now?: Date }): boolean {
  const { bucket, name, job } = opts;
  if (!bucket || !name) {
    process.stderr.write(`warning: ${job} proof not published — R2 bucket / profile name unset\n`);
    return false;
  }
  const key = jobProofKey(name, job);
  const file = join(tmpdir(), `job-proof-${job}-${process.pid}.json`);
  try {
    writeFileSync(file, JSON.stringify(jobProof(job, name, opts.now ?? new Date())) + "\n");
    const remote = process.env.RUNLOG_RCLONE_REMOTE ?? "r2";
    const put = capture("rclone", ["copyto", file, `${remote}:${bucket}/${key}`, "--s3-no-check-bucket"]);
    if (!put.ok) process.stderr.write(`warning: could not publish the ${job} proof to R2\n`);
    else process.stdout.write(`${job} proof published → ${key}\n`);
    return put.ok;
  } catch (e) {
    process.stderr.write(`warning: could not stage the ${job} proof: ${(e as Error).message}\n`);
    return false;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}
