import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveState } from "../lib/backupHistory.js";
import type { PublicRun, PublicVerification } from "../lib/backupTypes.js";

const now = Date.parse("2026-06-20T00:00:00Z");
const okRun = (): PublicRun => ({ t: "2026-06-19T16:00:00Z", ok: true, tiers: ["daily"], bytes: 1, runUrl: null });

test("deriveState: a FAILED verification → 'unverified' (not 'failed')", () => {
  const v: PublicVerification = { vt: "2026-06-19T16:00:00Z", ok: false, ratio: null };
  assert.equal(deriveState(okRun(), v, now), "unverified");
});

test("deriveState: a passing verification → 'verified'", () => {
  const v: PublicVerification = { vt: "2026-06-19T16:00:00Z", ok: true, ratio: 0.99 };
  assert.equal(deriveState(okRun(), v, now), "verified");
});

test("deriveState: no verification → 'ok'", () => {
  assert.equal(deriveState(okRun(), null, now), "ok");
});

test("deriveState: a FAILED backup stays 'failed' even with a (failed) verification — no collision", () => {
  const failedRun: PublicRun = { t: "2026-06-19T16:00:00Z", ok: false, tiers: [], bytes: null, runUrl: null };
  assert.equal(deriveState(failedRun, { vt: "x", ok: false, ratio: null }, now), "failed");
});

test("deriveState: an expired run is 'expired' regardless of verification", () => {
  // daily retention is 21 days; this run is ~400 days before `now`.
  const old: PublicRun = { t: "2025-05-01T16:00:00Z", ok: true, tiers: ["daily"], bytes: 1, runUrl: null };
  assert.equal(deriveState(old, { vt: "x", ok: true, ratio: 1 }, now), "expired");
});
