// ─────────────────────────────────────────────────────────────────────────────
// R2 persistence for the staleness alert episode (Actions-side, rclone). The decision itself is
// pure and lives in alertDecision.ts — shared with the Worker, which persists the SAME object
// (_status/<basename>/alert-state.json) through its R2 binding, so an episode that began under one
// runtime is throttled correctly by the other.
//
// Mirrors lib/slack.ts's daily-row storage (same bucket, same _status/<basename>/ prefix, same
// rclone-from-env configuration). All three helpers are best-effort by design: a read failure
// resolves to null (⇒ page), and a write failure only costs an extra page next tick.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./proc.js";
import { alertStateKey, parseAlertState, type AlertState } from "./alertDecision.js";

export { decideAlert, advanceAlertState, parseAlertState, alertStateKey } from "./alertDecision.js";
export type { AlertState, AlertDecision } from "./alertDecision.js";

export function readAlertState(bucket: string, basename: string): AlertState | null {
  const r = capture("rclone", ["cat", `r2:${bucket}/${alertStateKey(basename)}`, "--s3-no-check-bucket"]);
  return r.ok ? parseAlertState(r.out) : null;
}

export function writeAlertState(bucket: string, basename: string, state: AlertState): boolean {
  // Via a temp file + copyto, exactly as slack.ts persists the daily row — capture() wires the
  // child's stdin to "ignore", so an `rclone rcat` here would upload an empty object.
  const file = join(tmpdir(), `alert-state-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(state));
  try {
    return capture("rclone", ["copyto", file, `r2:${bucket}/${alertStateKey(basename)}`, "--s3-no-check-bucket"]).ok;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

export function clearAlertState(bucket: string, basename: string): boolean {
  const r = capture("rclone", ["deletefile", `r2:${bucket}/${alertStateKey(basename)}`, "--s3-no-check-bucket"]);
  return r.ok;
}
