// ─────────────────────────────────────────────────────────────────────────────
// Writes this run's OUTCOME record (lib/jobOutcome.ts) to the client's private bucket as the process
// exits — the only thing a job now says about itself; the scheduler Worker turns it into Slack.
//
// Written from a process "exit" listener, so EVERY way out records something: a clean finish, a
// script's fail()/fatal() → process.exit(1), loadConfig()'s exit on a bad profile, an uncaught error,
// and the SIGINT/SIGTERM → exit(130/143) handlers the scripts install (a cancel or timeout-minutes).
// "exit" listeners must be synchronous, and capture() is spawnSync, so the rclone upload completes
// before the process does.
//
// A non-zero exit that recorded no reason still records a page (`exit_<code>`), so a crash is never
// announced as a success. Off Actions (no GITHUB_RUN_ID) it writes nothing — a local run is not a
// scheduled run, and there is no notify step to announce it anyway.
// ─────────────────────────────────────────────────────────────────────────────

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./proc.js";
import { peekProfile } from "./config.js";
import { buildRawProfile } from "./profile.js";
import {
  clampAlert,
  isOutcomeName,
  MAX_ALERTS,
  OUTCOME_VERSION,
  outcomeKey,
  type JobOutcome,
  type OutcomeAlert,
  type OutcomeJob,
  type OutcomeSummary,
  type Severity,
} from "./jobOutcome.js";
import { drainOutcomeAlerts, outcomeAlert } from "./outcomeSink.js";
import type { RunOrigin } from "./runOrigin.js";

export interface OutcomeRecorder {
  /** The profile name, once known (else read tolerantly from the profile at flush). */
  setName(name: string): void;
  /** backup only: how the run was started. */
  setOrigin(origin: RunOrigin): void;
  summary(s: OutcomeSummary): void;
  /** Record an alert (same as lib/outcomeSink.ts outcomeAlert). */
  alert(severity: Severity, code: string, text: string): void;
  /** Write nothing at exit — for runs that must not touch the store (archive --dry-run=store, a local target). */
  suppress(reason: string): void;
  /** Build and upload the record. Once only; never throws. Returns whether it landed. */
  flush(exitCode: number): boolean;
  /** The record as it would be written now (for tests and logging). null when there is no run identity. */
  build(exitCode: number): JobOutcome | null;
}

// Same clamp as runlog.ts: this is a control-plane write on the way out, and a hung exit is worse
// than a lost record (the Worker's GitHub fallback still announces a failed run without one).
const BOUNDED = ["--retries", "1", "--low-level-retries", "2", "--timeout", "30s", "--contimeout", "10s"];

const warn = (msg: string): void => void process.stderr.write(`outcome: ${msg}\n`);

/** Reason for an exit that recorded none. 130/143 are the scripts' SIGINT/SIGTERM handlers: a cancel or a timeout. */
function exitReason(code: number): string {
  if (code === 130 || code === 143) return `the job was cancelled or timed out (exit ${code}) before it finished`;
  return `the job exited with code ${code} without recording a reason — see the job log`;
}

/** Configure the `r2` rclone remote from the R2_* env when the script hasn't yet (e.g. a config failure). */
function ensureRemote(remote: string): void {
  if (remote !== "r2" || process.env.RCLONE_CONFIG_R2_TYPE) return;
  const { R2_ACCOUNT_ID: acct, R2_ACCESS_KEY_ID: key, R2_SECRET_ACCESS_KEY: secret } = process.env;
  if (!acct || !key || !secret) return;
  process.env.RCLONE_CONFIG_R2_TYPE = "s3";
  process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
  process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = key;
  process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = secret;
  process.env.RCLONE_CONFIG_R2_ENDPOINT = `https://${acct}.r2.cloudflarestorage.com`;
}

function profileName(): string | undefined {
  try {
    const validated = peekProfile()?.name;
    if (validated) return validated;
    // Raw, like runlog.ts: peekProfile() is null whenever the profile fails even the loose schema —
    // a typo'd key, an out-of-range number, a retired `slack.channel` — which is exactly the
    // config_invalid run this record exists to announce. flush() checks the shape before it keys on it.
    const raw = buildRawProfile().name;
    return typeof raw === "string" ? raw : undefined;
  } catch {
    return undefined; // an unreadable $PROFILE must not stop the record — it just can't be named
  }
}

/**
 * Start recording `job`'s outcome. Registers the exit listener unless `register: false` (tests).
 * Call it FIRST in main(), before config is loaded, so a config failure is recorded too.
 */
export function startOutcome(job: OutcomeJob, opts: { now?: () => Date; register?: boolean } = {}): OutcomeRecorder {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  let name: string | undefined;
  let origin: RunOrigin | null = null;
  let summary: OutcomeSummary | null = null;
  let suppressed: string | null = null;
  let flushed = false;
  const alerts: OutcomeAlert[] = [];

  const build = (exitCode: number): JobOutcome | null => {
    const runId = process.env.GITHUB_RUN_ID ?? "";
    if (!/^\d+$/.test(runId)) return null;
    const attempt = Number(process.env.GITHUB_RUN_ATTEMPT || "1");
    const jobId = process.env.GITFATHER_JOB_ID ?? "";
    alerts.push(...drainOutcomeAlerts()); // accumulate (idempotent) — build() may run more than once
    let all = alerts.map(clampAlert);
    if (exitCode !== 0 && !all.some((a) => a.severity === "page")) {
      all.push({ severity: "page", code: `exit_${exitCode}`.slice(0, 40), text: exitReason(exitCode) });
    }
    if (all.length > MAX_ALERTS) {
      const dropped = all.length - (MAX_ALERTS - 1);
      const severity: Severity = all.slice(MAX_ALERTS - 1).some((a) => a.severity === "page") ? "page" : "warn";
      all = [...all.slice(0, MAX_ALERTS - 1), { severity, code: "truncated", text: `${dropped} more alert(s) not shown — see the job log` }];
    }
    const finished = now();
    return {
      version: OUTCOME_VERSION,
      source: "job",
      job,
      name: name ?? profileName() ?? "",
      runId,
      runAttempt: Number.isInteger(attempt) && attempt >= 1 ? attempt : 1,
      jobId: /^\d+$/.test(jobId) ? jobId : null,
      ok: exitCode === 0 && !all.some((a) => a.severity === "page"),
      exitCode,
      startedAt: startedAt.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - startedAt.getTime()),
      origin,
      summary,
      alerts: all,
    };
  };

  const recorder: OutcomeRecorder = {
    setName: (n) => void (name = n),
    setOrigin: (o) => void (origin = o),
    summary: (s) => void (summary = s),
    alert: (severity, code, text) => outcomeAlert(severity, code, text),
    suppress: (reason) => void (suppressed = reason),
    build,
    flush(exitCode: number): boolean {
      if (flushed) return false;
      flushed = true;
      if (suppressed) {
        process.stdout.write(`outcome: not recorded (${suppressed})\n`);
        return false;
      }
      const rec = build(exitCode);
      if (!rec) return false; // not in Actions — nothing to announce
      if (!isOutcomeName(rec.name)) {
        warn(`cannot record: profile name ${JSON.stringify(rec.name)} is missing or not a plain [A-Za-z0-9._-] name`);
        return false;
      }
      const bucket = process.env.R2_BUCKET;
      if (!bucket) {
        warn("cannot record: R2_BUCKET is not set");
        return false;
      }
      const remote = process.env.RUNLOG_RCLONE_REMOTE ?? "r2";
      ensureRemote(remote);
      const key = outcomeKey(rec);
      const file = join(tmpdir(), `outcome-${process.pid}.json`);
      try {
        writeFileSync(file, JSON.stringify(rec));
        const put = capture("rclone", ["copyto", file, `${remote}:${bucket}/${key}`, "--s3-no-check-bucket", ...BOUNDED]);
        if (!put.ok) {
          warn(`could not write ${key}: ${put.stderr.trim().split("\n").pop() ?? ""}`);
          return false;
        }
        process.stdout.write(`outcome: recorded ${rec.ok ? "ok" : "FAILED"} → ${key}\n`);
        return true;
      } catch (e) {
        warn(`could not stage the record: ${(e as Error).message}`);
        return false;
      } finally {
        try {
          unlinkSync(file);
        } catch {
          /* temp cleanup is best-effort */
        }
      }
    },
  };

  if (opts.register !== false) process.on("exit", (code) => void recorder.flush(code));
  return recorder;
}
