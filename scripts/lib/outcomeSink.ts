// ─────────────────────────────────────────────────────────────────────────────
// Where a job's alerts collect until its outcome record is written (lib/outcomeRecorder.ts).
//
// A LEAF module on purpose: lib/config.ts reports config failures here, and the recorder imports
// config.ts, so the two can only share state through something that imports neither.
// ─────────────────────────────────────────────────────────────────────────────

import type { OutcomeAlert, Severity } from "./jobOutcome.js";

const pending: OutcomeAlert[] = [];

/** Record an alert for this run's outcome. Harmless when no recorder is running (it is simply never written). */
export function outcomeAlert(severity: Severity, code: string, text: string): void {
  pending.push({ severity, code, text });
}

/** Everything recorded so far, oldest first; empties the sink. */
export function drainOutcomeAlerts(): OutcomeAlert[] {
  return pending.splice(0);
}
