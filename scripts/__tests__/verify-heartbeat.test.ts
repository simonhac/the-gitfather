import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyHeartbeatVerdict, type VerifyHeartbeatInputs } from "../lib/verifyHeartbeat.js";

// A run that proved restorability: clean, complete listing, a restore actually happened.
const GOOD: VerifyHeartbeatInputs = {
  failures: 0,
  listingOk: true,
  objectCount: 12,
  canRestore: true,
  restoreLegEnabled: true,
  maxRestores: 2,
  restoresThisRun: 1,
  recentRestoreOnRecord: true,
};
const w = (o: Partial<VerifyHeartbeatInputs>) => verifyHeartbeatVerdict({ ...GOOD, ...o });

test("a clean run with a successful restore pings", () => {
  assert.deepEqual(verifyHeartbeatVerdict(GOOD), { allowed: true });
});

test("'nothing was DUE' still pings — a recent object is already restore-verified", () => {
  // The legitimately-healthy steady state. Requiring work-done every run would make the heartbeat
  // go quiet on healthy days, which is the opposite of what a dead-man's switch is for.
  const v = w({ restoresThisRun: 0, recentRestoreOnRecord: true });
  assert.deepEqual(v, { allowed: true });
});

test("'nothing was POSSIBLE' does NOT ping — these are the false greens a review caught", () => {
  // Each of these produced a green heartbeat in the first version, which claims "your backups
  // restore" when nobody restored anything.
  const cases: [string, Partial<VerifyHeartbeatInputs>, RegExp][] = [
    ["pg_restore/psql missing on the runner", { canRestore: false }, /unavailable/],
    ["fresh:false and aged:false", { restoreLegEnabled: false }, /no restore leg/],
    ["max-restores: 0", { maxRestores: 0 }, /max-restores/],
    ["no restore this run and none on record", { restoresThisRun: 0, recentRestoreOnRecord: false }, /no recent restore/],
  ];
  for (const [label, override, reason] of cases) {
    const v = w(override);
    assert.equal(v.allowed, false, label);
    assert.match(v.allowed === false ? v.reason : "", reason, label);
  }
});

test("a failed tier listing blocks the ping", () => {
  // A partial listing makes the census floor meaningless — it can only catch omissions it knows to
  // expect — so an incomplete enumeration must not read as a clean verify.
  const v = w({ listingOk: false });
  assert.equal(v.allowed, false);
  assert.match(v.allowed === false ? v.reason : "", /enumeration was incomplete/);
});

test("any failure blocks the ping, and is reported first", () => {
  const v = w({ failures: 3 });
  assert.equal(v.allowed, false);
  assert.match(v.allowed === false ? v.reason : "", /3 check\(s\) failed/);
});

test("an empty bucket is not a clean verify", () => {
  // "Exited 0" over nothing verifies nothing.
  const v = w({ objectCount: 0 });
  assert.equal(v.allowed, false);
  assert.match(v.allowed === false ? v.reason : "", /no durable objects/);
});

test("capability is checked even when a restore somehow happened", () => {
  // Defensive: the capability gates must not be bypassable by restoresThisRun alone, or a
  // misconfigured profile could still claim restorability.
  assert.equal(w({ canRestore: false, restoresThisRun: 5 }).allowed, false);
  assert.equal(w({ maxRestores: 0, restoresThisRun: 5 }).allowed, false);
});

// ── Keyless mode (CB-303) ───────────────────────────────────────────────────
// A job that deliberately cannot restore, because the age identity is offline. Its claim is
// narrower — "the stored bytes are unchanged" — and it must still be able to make it.

/** What a healthy keyless run looks like: no restore is possible, and one object was re-hashed. */
const KEYLESS: VerifyHeartbeatInputs = {
  failures: 0,
  listingOk: true,
  objectCount: 37,
  canRestore: false, // hard-set by keyless mode, not a broken runner
  restoreLegEnabled: false,
  maxRestores: 0,
  restoresThisRun: 0,
  recentRestoreOnRecord: false,
  keyless: true,
  hashesThisRun: 1,
};
const k = (o: Partial<VerifyHeartbeatInputs>) => verifyHeartbeatVerdict({ ...KEYLESS, ...o });

test("keyless: a clean run DOES publish its proof — the regression that started CB-303's rework", () => {
  // Before this branch existed, `!canRestore` returned allowed:false, which keyless sets
  // unconditionally. The proof was therefore withheld on EVERY run, forever, and /health/jobs
  // would have reported the job dead ~30h after it shipped while the job itself exited 0 nightly.
  assert.deepEqual(verifyHeartbeatVerdict(KEYLESS), { allowed: true });
});

test("keyless: nothing hash-checked this run withholds the proof", () => {
  // Not a free pass. The rotating re-hash guarantees something is always due, so this is a
  // REACHABLE failure meaning "nobody checked anything today" — the condition the whole gate
  // exists to catch, preserved in the mode that no longer restores.
  const v = k({ hashesThisRun: 0 });
  assert.equal(v.allowed, false);
  assert.match((v as { reason: string }).reason, /nothing was hash-checked/);
});

test("keyless: a hash-check FAILURE still withholds the proof", () => {
  assert.equal(k({ failures: 1 }).allowed, false);
});

test("keyless: an incomplete listing or an empty corpus still withholds the proof", () => {
  assert.equal(k({ listingOk: false }).allowed, false);
  assert.equal(k({ objectCount: 0 }).allowed, false);
});

test("keyless does not leak into normal mode: an unrestorable non-keyless run is still withheld", () => {
  // The old clauses must be untouched — this is the case that made the gate worth having.
  const v = w({ canRestore: false });
  assert.equal(v.allowed, false);
  assert.match((v as { reason: string }).reason, /restorability was not tested/);
});
