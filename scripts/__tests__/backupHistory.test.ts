import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveState, buildBackupGrid } from "../lib/backupHistory.js";
import {
  DEFAULT_RETENTION,
  oldestHashAgeDays,
  pickVerification,
  selectRehashTargets,
} from "../lib/backupTypes.js";
import type { PublicRun, PublicVerification, PublicPayload } from "../lib/backupTypes.js";

const now = Date.parse("2026-06-20T00:00:00Z");
const okRun = (): PublicRun => ({ t: "2026-06-19T16:00:00Z", ok: true, tiers: ["daily"], bytes: 1, runUrl: null });

test("deriveState: a FAILED verification → 'unverified' (not 'failed')", () => {
  const v: PublicVerification = { vt: "2026-06-19T16:00:00Z", ok: false, ratio: null };
  assert.equal(deriveState(okRun(), v, now), "unverified");
});

// ── What the BRIGHT cell claims ──────────────────────────────────────────────
// The legend says brighter green = restore-verified, so only a record that proves the STORED object
// restores may set it. deriveState used to return "verified" for ANY passing verification, which
// painted a byte-integrity check exactly like a full restore. One test per kind, because this is
// the single line the whole dashboard's honesty rests on.

const vOf = (over: Partial<PublicVerification>): PublicVerification => ({
  vt: "2026-06-19T16:00:00Z",
  ok: true,
  ratio: null,
  ...over,
});

test("deriveState: a passing verification with NO kind (legacy) → 'verified'", () => {
  // Records predating the `kind` field were all full restores, so absence means "restore".
  assert.equal(deriveState(okRun(), vOf({ ratio: 0.99 }), now), "verified");
});

test("deriveState: kind 'restore' → 'verified' (bright — the stored object was restored)", () => {
  assert.equal(deriveState(okRun(), vOf({ kind: "restore", ratio: 0.99 }), now), "verified");
});

test("deriveState: kind 'hash' → 'ok', NOT 'verified' — bytes intact is not a restore", () => {
  assert.equal(deriveState(okRun(), vOf({ kind: "hash" }), now), "ok");
});

test("deriveState: kind 'pre-encrypt' → 'ok' — the dump restored, but not the object in the bucket", () => {
  // Pre-encrypt verification happens before upload, so it cannot speak for the stored ciphertext.
  // If this returned "verified", every cell would go bright the moment the backup job started
  // recording — the exact inversion this discrimination exists to prevent.
  assert.equal(deriveState(okRun(), vOf({ kind: "pre-encrypt", ratio: 1 }), now), "ok");
});

test("deriveState: a FAILED verification is amber whatever its kind", () => {
  for (const kind of ["restore", "hash", "pre-encrypt"] as const) {
    assert.equal(deriveState(okRun(), vOf({ kind, ok: false }), now), "unverified", kind);
  }
});

// ── Which record speaks for a dump ───────────────────────────────────────────
// One stamp now collects a pre-encrypt at dump time, a hash check daily, and a restore whenever
// someone drills. The old "first wins, a pass replaces a fail" rule breaks both ways under that.

const rec = (over: Partial<PublicVerification>): PublicVerification => ({
  vt: "2026-06-19T16:00:00Z",
  ok: true,
  ratio: null,
  ...over,
});

test("pickVerification: a manual restore beats the pre-encrypt record that landed first", () => {
  // The bright cell Simon earns by hand has to survive a dedup that used to keep the EARLIEST
  // record. Pre-encrypt is written at dump time, so it is always first — and always passes.
  const picked = pickVerification([
    rec({ t: "2026-06-19T16:05:00Z", kind: "pre-encrypt" }),
    rec({ t: "2026-06-20T18:30:00Z", kind: "hash" }),
    rec({ t: "2026-06-25T09:00:00Z", kind: "restore", by: "manual" }),
  ]);
  assert.equal(picked?.kind, "restore");
  assert.equal(deriveState(okRun(), picked, now), "verified");
});

test("pickVerification: a routine hash check does NOT clear a failed restore", () => {
  // Bytes being intact is exactly what you would see for an object that will not open, so this is
  // the one pass that must not wipe that amber. Under the old rule the next day's check erased it.
  const picked = pickVerification([
    rec({ t: "2026-06-19T16:05:00Z", kind: "pre-encrypt" }),
    rec({ t: "2026-06-20T09:00:00Z", kind: "restore", ok: false }),
    rec({ t: "2026-06-21T18:30:00Z", kind: "hash" }),
    rec({ t: "2026-06-22T18:30:00Z", kind: "hash" }),
  ]);
  assert.equal(picked?.ok, false);
  assert.equal(deriveState(okRun(), picked, now), "unverified");
});

test("pickVerification: a re-drill that passes DOES clear the earlier failed restore", () => {
  const picked = pickVerification([
    rec({ t: "2026-06-20T09:00:00Z", kind: "restore", ok: false }),
    rec({ t: "2026-06-21T09:00:00Z", kind: "restore" }),
  ]);
  assert.equal(picked?.ok, true);
  assert.equal(deriveState(okRun(), picked, now), "verified");
});

test("pickVerification: a failed hash check outranks a passing pre-encrypt — the bytes moved", () => {
  // A hash mismatch means the stored object changed. A pre-encrypt pass predates the upload
  // entirely, so it cannot answer that, and must not hide it.
  const picked = pickVerification([
    rec({ t: "2026-06-19T16:05:00Z", kind: "pre-encrypt" }),
    rec({ t: "2026-06-21T18:30:00Z", kind: "hash", ok: false }),
  ]);
  assert.equal(picked?.ok, false);
});

test("pickVerification: with no failures, the strongest passing claim wins", () => {
  const picked = pickVerification([rec({ kind: "hash" }), rec({ kind: "pre-encrypt" })]);
  assert.equal(picked?.kind, "pre-encrypt");
  assert.equal(deriveState(okRun(), picked, now), "ok", "neither proves the stored object restores");
});

test("pickVerification: legacy records with no timestamps keep the old pass-beats-fail behaviour", () => {
  // Nothing can be ordered without `t`, so a pass of sufficient rank still clears a failure —
  // otherwise history would sprout amber cells that were green yesterday.
  const picked = pickVerification([rec({ ok: false }), rec({ ok: true })]);
  assert.equal(picked?.ok, true);
});

test("pickVerification: no records → null", () => {
  assert.equal(pickVerification([]), null);
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

// ── The rotating re-hash (CB-303 Phase 3b) ──────────────────────────────────
// With the age identity offline, "the stored bytes are unchanged" is the only ONGOING claim the
// daily job makes — and a claim made once, on first sight, is not ongoing. One object per run is
// re-hashed, least-recently-hashed first, which sweeps the corpus without downloading it nightly.

const cand = (key: string, lastHashedMs: number | null) => ({ key, lastHashedMs });
const DAY = 86_400_000;

test("selectRehashTargets: least recently hashed first", () => {
  const picked = selectRehashTargets(
    [cand("daily/c", 300), cand("monthly/a", 100), cand("weekly/b", 200)],
    1,
  );
  assert.deepEqual(picked, ["monthly/a"]);
});

test("selectRehashTargets: NEVER hashed outranks everything hashed", () => {
  // Includes the pre-switch plaintext objects CB-265 is still waiting on — they drain first
  // without anyone scheduling them.
  const picked = selectRehashTargets([cand("daily/hashed", 1), cand("monthly/never", null)], 1);
  assert.deepEqual(picked, ["monthly/never"]);
});

test("selectRehashTargets: respects the per-run budget and is deterministic on ties", () => {
  const picked = selectRehashTargets([cand("b", 100), cand("a", 100), cand("c", 50)], 2);
  assert.deepEqual(picked, ["c", "a"], "oldest, then the tie broken by key — same input, same pick");
});

test("selectRehashTargets: a budget of 0 picks nothing, and an empty corpus is not an error", () => {
  assert.deepEqual(selectRehashTargets([cand("a", 1)], 0), []);
  assert.deepEqual(selectRehashTargets([], 1), []);
});

test("selectRehashTargets: the budget lands on LONG-LIVED objects without a rule saying so", () => {
  // The property the design leans on. A daily copy lives 21 days; a sweep of ~46 objects at one a
  // day takes ~46. So a daily object's last-hash age never reaches the front of the queue, and the
  // budget goes to the weekly/monthly copies that would otherwise sit unchecked for up to a year.
  const now = 1_000 * DAY;
  const corpus = [
    ...Array.from({ length: 21 }, (_, i) => cand(`daily/${i}`, now - i * DAY)), // hashed within 21d
    cand("monthly/old", now - 44 * DAY),
    cand("weekly/older", now - 45 * DAY),
  ];
  assert.deepEqual(selectRehashTargets(corpus, 2), ["weekly/older", "monthly/old"]);
});

test("oldestHashAgeDays: measures the laggard, and treats never-hashed as maximally stale", () => {
  const now = 100 * DAY;
  assert.equal(oldestHashAgeDays([cand("a", now - 10 * DAY), cand("b", now - 3 * DAY)], now), 10);
  assert.equal(oldestHashAgeDays([cand("a", now), cand("b", null)], now), Infinity);
  assert.equal(oldestHashAgeDays([], now), null, "nothing to measure is not the same as stale");
});
