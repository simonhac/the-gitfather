// ─────────────────────────────────────────────────────────────────────────────
// Credential-age monitoring — "when was this R2 token last rotated?"
//
// The rotation date is recorded by roll-r2-token.ts into the run-log at the moment it publishes,
// which is the only moment anything downstream knows it happened: a GitHub secret cannot be read
// back, and listing repository secrets needs a token more privileged than the workflow's own. So
// the record is ours, written where every job can already read it, and needing no new privilege.
//
// The one rule that makes this worth having: **absence is not health.** A credential with no record
// is the one MOST likely to be ancient — nobody has rotated it through the tool, ever. If "no
// record" resolved to ok, the check would be loud about credentials someone is already looking
// after and silent about the one that has sat untouched since the day it was created. So a missing
// record is `unknown`, and `unknown` is reported alongside `due`, not alongside `ok`.
// ─────────────────────────────────────────────────────────────────────────────

/** One rotation, appended when roll-r2-token.ts publishes. Holds no secret — the tail is 4 chars. */
export interface LogCredential {
  /** ISO-8601 UTC — when the credential was rotated. */
  ts: string;
  /** Credential prefix, matching the env-var names: R2, DASHBOARD_R2, R2_READONLY, … */
  prefix: string;
  bucket: string;
  /** Where it was published, or null for an escrow-only operator credential. */
  repo: string | null;
  /** Last 4 of the Access Key ID — enough to tell two rotations apart, useless as a credential. */
  keyIdTail: string;
}

export type CredentialState = "ok" | "due" | "unknown";

export interface CredentialVerdict {
  prefix: string;
  state: CredentialState;
  /** Whole days since rotation; null when there is nothing to measure. */
  ageDays: number | null;
  maxAgeDays: number;
  message: string;
}

const DAY_MS = 86_400_000;

/**
 * A verdict per tracked prefix, in the order asked.
 *
 * @param maxAgeDays 0 disables the check entirely (returns []).
 */
export function credentialVerdicts(
  records: readonly LogCredential[],
  track: readonly string[],
  maxAgeDays: number,
  nowMs: number,
): CredentialVerdict[] {
  if (maxAgeDays <= 0) return [];
  return track.map((prefix) => {
    const newest = records
      .filter((r) => r.prefix === prefix)
      .map((r) => Date.parse(r.ts))
      .filter((ms) => !Number.isNaN(ms))
      .sort((a, b) => b - a)[0];

    if (newest === undefined) {
      return {
        prefix,
        state: "unknown",
        ageDays: null,
        maxAgeDays,
        message: `${prefix}: never recorded — rotate it with roll-r2-token.ts so its age is known`,
      };
    }
    if (newest > nowMs) {
      // Clock skew, or a hand-edited record. Either way it must not read as freshly rotated.
      return {
        prefix,
        state: "unknown",
        ageDays: null,
        maxAgeDays,
        message: `${prefix}: recorded rotation is in the future (${new Date(newest).toISOString()}) — treat the age as unknown`,
      };
    }
    const ageDays = Math.floor((nowMs - newest) / DAY_MS);
    return ageDays > maxAgeDays
      ? { prefix, state: "due", ageDays, maxAgeDays, message: `${prefix}: ${ageDays} days old (max ${maxAgeDays}) — rotation due` }
      : { prefix, state: "ok", ageDays, maxAgeDays, message: `${prefix}: ${ageDays} days old (max ${maxAgeDays})` };
  });
}

/** The prefixes needing attention — `due` and `unknown` together, because both mean "not known good". */
export function needsAttention(verdicts: readonly CredentialVerdict[]): CredentialVerdict[] {
  return verdicts.filter((v) => v.state !== "ok");
}
