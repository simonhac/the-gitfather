// ─────────────────────────────────────────────────────────────────────────────
// When may durable-verify ping its dead-man's switch?
//
// The heartbeat's claim is "these backups are provably restorable". That is a much stronger claim
// than "the job exited 0", and the first version of this gate did not earn it: it required only
// `failures === 0` and a non-empty listing, so a run that RESTORED NOTHING still pinged.
//
// Four ways that happened, all schema-valid or environmental:
//   - pg_restore/psql missing on the runner  → canRestore=false, warns, every restore skipped
//   - max-restores: 0                        → valid config, every restore skipped
//   - fresh:false + aged:false               → valid config, zero hashes AND zero restores
//   - the freshest daily older than retestDays → "no fresh daily due", nothing restored
//
// The distinction that matters is "nothing was DUE" (healthy — everything is already verified)
// versus "nothing was POSSIBLE" (not healthy — nobody checked). Only the first may ping.
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyHeartbeatInputs {
  /** Every check that ran and failed: hash mismatches, restore gates, the census floor. */
  failures: number;
  /** Every tier listing returned cleanly. A partial listing makes the census floor meaningless. */
  listingOk: boolean;
  /** Durable objects enumerated. Zero means there is nothing to make a claim about. */
  objectCount: number;
  /** pg_restore + psql are present on the runner. */
  canRestore: boolean;
  /** At least one restore leg is enabled in the profile. */
  restoreLegEnabled: boolean;
  /** The per-run restore cap. Zero disables restores entirely. */
  maxRestores: number;
  /** Full restores that SUCCEEDED this run. */
  restoresThisRun: number;
  /** A durable object newer than retest-days already carries a successful restore verification. */
  recentRestoreOnRecord: boolean;
}

export type VerifyHeartbeatVerdict = { allowed: true } | { allowed: false; reason: string };

export function verifyHeartbeatVerdict(i: VerifyHeartbeatInputs): VerifyHeartbeatVerdict {
  if (i.failures > 0) return { allowed: false, reason: `${i.failures} check(s) failed` };
  if (!i.listingOk) return { allowed: false, reason: "a tier listing failed — enumeration was incomplete" };
  if (i.objectCount === 0) return { allowed: false, reason: "no durable objects were seen" };
  if (!i.canRestore) return { allowed: false, reason: "pg_restore/psql unavailable — restorability was not tested" };
  if (!i.restoreLegEnabled) return { allowed: false, reason: "no restore leg enabled (fresh and aged are both off)" };
  if (i.maxRestores <= 0) return { allowed: false, reason: "max-restores is 0 — restores are disabled" };
  // The heart of it. A restore this run is direct proof. Absent that, a recent object already
  // carrying a successful restore is the "nothing was due" case, which is legitimately healthy.
  // Neither, and nobody has proved these restore lately.
  if (i.restoresThisRun === 0 && !i.recentRestoreOnRecord) {
    return { allowed: false, reason: "no restore this run and no recent restore on record" };
  }
  return { allowed: true };
}
