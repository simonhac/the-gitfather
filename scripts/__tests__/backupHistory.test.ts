import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveState, buildBackupGrid } from "../lib/backupHistory.js";
import { DEFAULT_RETENTION } from "../lib/backupTypes.js";
import type { PublicRun, PublicVerification, PublicPayload } from "../lib/backupTypes.js";

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

// ── The two channels of a backup cell ────────────────────────────────────────
// A slot's BODY says what we hold; its MARK says how the runs went. Neither is derivable from the
// other, and the interesting cases are exactly the ones where they disagree.

const GRID_NOW = new Date("2026-06-20T00:00:00Z");
const gridWith = (runs: PublicRun[], verifications: PublicVerification[] = []): PublicPayload => ({
  label: "db",
  generatedAt: GRID_NOW.toISOString(),
  retention: DEFAULT_RETENTION,
  runs,
  verifications,
});
/** The one cell a single-slot payload produces. */
const onlyCell = (payload: PublicPayload) => {
  const cells = buildBackupGrid(payload, GRID_NOW).rows.flatMap((r) => [...r.cells.values()]);
  assert.equal(cells.length, 1, "expected exactly one cell");
  return cells[0];
};
const backup = (t: string, over: Partial<PublicRun> = {}): PublicRun => ({
  t, ok: true, tiers: ["2hourly", "daily"], bytes: 1_000, runUrl: null, ...over,
});

test("buildBackupGrid: a clean run is a body with nothing to add", () => {
  const cell = onlyCell(gridWith([backup("2026-06-19T16:00:00Z")]));
  assert.equal(cell.body, "ok");
  assert.deepEqual(cell.mark, { worst: "ok", second: null, codes: 1 });
});

test("buildBackupGrid: a failed run has NO body — the mark carries the failure", () => {
  const cell = onlyCell(gridWith([backup("2026-06-19T16:00:00Z", { ok: false, tiers: [], bytes: null })]));
  assert.equal(cell.body, null);
  assert.deepEqual(cell.mark, { worst: "failed", second: null, codes: 1 });
});

test("buildBackupGrid: a failed drill keeps the body and moves the amber to the mark", () => {
  const cell = onlyCell(gridWith(
    [backup("2026-06-19T16:00:00Z")],
    [{ vt: "2026-06-19T16:00:00Z", ok: false, ratio: null }],
  ));
  assert.equal(cell.body, "ok", "the dump is still a dump");
  assert.deepEqual(cell.mark, { worst: "attention", second: null, codes: 1 });
});

test("buildBackupGrid: a rerun that failed beside a run that didn't is one body and two codes", () => {
  const cell = onlyCell(gridWith([
    backup("2026-06-19T16:00:00Z"),
    backup("2026-06-19T16:40:00Z", { ok: false, tiers: [], bytes: null }),
  ]));
  assert.equal(cell.body, "ok", "we still hold the dump the first run made");
  assert.deepEqual(cell.mark, { worst: "failed", second: "ok", codes: 2 }, "two dashes");
  assert.equal(cell.runs.length, 2);
});

test("buildBackupGrid: the body is the BEST thing the slot holds", () => {
  const cell = onlyCell(gridWith(
    [backup("2026-06-19T16:00:00Z"), backup("2026-06-19T16:40:00Z")],
    [{ vt: "2026-06-19T16:40:00Z", ok: true, ratio: 0.99 }],
  ));
  assert.equal(cell.body, "verified");
  assert.deepEqual(cell.mark, { worst: "ok", second: null, codes: 1 });
});

test("buildBackupGrid: an EXPIRED dump whose drill failed keeps both channels", () => {
  // deriveState reports `expired` without looking at the verification, so a mark taken from the
  // cell state would silently drop the amber. The body greys out; the mark does not.
  const cell = onlyCell(gridWith(
    [backup("2026-05-01T16:00:00Z")],
    [{ vt: "2026-05-01T16:00:00Z", ok: false, ratio: null }],
  ));
  assert.equal(cell.body, "expired");
  assert.deepEqual(cell.mark, { worst: "attention", second: null, codes: 1 });
});
