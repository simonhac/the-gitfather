import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_W,
  CELL_H,
  cellOps,
  bodyClass,
  archiveBody,
  archiveCode,
  archiveMark,
  type RectOp,
} from "../lib/cellGlyph.js";
import { backupCode, runBodyState } from "../lib/backupHistory.js";
import { summarizeOutcomes, NO_MARK, type OutcomeCode } from "../lib/outcomes.js";

// The glyph is asserted as an op LIST rather than as rendered SVG: the grid, the legend swatches and
// these tests all consume the same list, so pinning it here pins what a reader actually sees.

const classes = (ops: RectOp[]): string[] => ops.map((o) => o.cls);
const mark = (...codes: OutcomeCode[]) => summarizeOutcomes(codes);

const run = (ok: boolean, ver: boolean | null = null) => ({
  run: { ok },
  verification: ver === null ? null : { ok: ver },
});

// ── The body channel ─────────────────────────────────────────────────────────

test("runBodyState: a failed drill still paints a plain body — the amber lives in the mark", () => {
  assert.equal(runBodyState("verified"), "verified");
  assert.equal(runBodyState("ok"), "ok");
  assert.equal(runBodyState("unverified"), "ok");
  assert.equal(runBodyState("expired"), "expired");
  assert.equal(runBodyState("failed"), null, "a failed run produced no data — the mark carries it");
  assert.equal(runBodyState("empty"), null);
});

test("bodyClass: one mapping from lifecycle state to colour, for both cell kinds", () => {
  assert.equal(bodyClass("ok"), "b-ok");
  assert.equal(bodyClass("verified"), "b-verified");
  assert.equal(bodyClass("expired"), "b-expired");
  assert.equal(bodyClass("archived"), "b-archived");
  assert.equal(bodyClass("pruned"), "b-pruned");
  assert.equal(bodyClass(null), null);
});

test("archiveBody: only a week that stored something has a body", () => {
  assert.equal(archiveBody({ successState: "archived" }), "b-archived");
  assert.equal(archiveBody({ successState: "quiet" }), null);
  assert.equal(archiveBody({ successState: null }), null);
});

// ── Per-run codes ────────────────────────────────────────────────────────────

test("backupCode: reads the run and its verification, not the derived state", () => {
  assert.equal(backupCode(run(false)), "failed");
  assert.equal(backupCode(run(true, false)), "attention");
  assert.equal(backupCode(run(true, true)), "ok");
  assert.equal(backupCode(run(true)), "ok");
});

test("backupCode: an EXPIRED dump whose drill failed keeps its amber", () => {
  // deriveState() reports `expired` before it ever looks at the verification, so a code taken from
  // SlotRun.state would silently drop this. Taking it from the run + verification does not.
  assert.equal(backupCode(run(true, false)), "attention");
});

test("archiveCode: a refusal is attention, not failure — the gate declined on purpose", () => {
  assert.equal(archiveCode({ state: "failed" }), "failed");
  assert.equal(archiveCode({ state: "attention" }), "attention");
  assert.equal(archiveCode({ state: "archived" }), "ok");
  assert.equal(archiveCode({ state: "quiet" }), "ok");
});

test("archiveMark: folds a week's runs down to distinct codes", () => {
  assert.deepEqual(archiveMark({ runs: [{ state: "archived" }, { state: "attention" }] as never }), {
    worst: "attention", second: "ok", codes: 2,
  });
});

// ── The glyph ────────────────────────────────────────────────────────────────

test("cellOps: a clean backup is a body and nothing else", () => {
  assert.deepEqual(classes(cellOps("b-ok", mark("ok"))), ["b-ok"]);
  assert.deepEqual(classes(cellOps("b-verified", mark("ok"))), ["b-verified"]);
  assert.deepEqual(classes(cellOps("b-expired", NO_MARK)), ["b-expired"]);
});

test("cellOps: a failed run is a red bar in a BLANK cell — it produced no data", () => {
  assert.deepEqual(classes(cellOps(null, mark("failed"))), ["moat", "m-failed"]);
});

test("cellOps: a drill failure is an amber bar under a filled body", () => {
  assert.deepEqual(classes(cellOps("b-ok", mark("attention"))), ["b-ok", "moat", "m-attention"]);
});

test("cellOps: more than one distinct outcome splits the bar into two dashes", () => {
  assert.deepEqual(classes(cellOps("b-ok", mark("failed", "ok"))), ["b-ok", "moat", "m-failed", "m-ok"]);
  // Worst first, then the next-worst — not the runs' order.
  assert.deepEqual(classes(cellOps("b-ok", mark("ok", "attention", "failed"))), [
    "b-ok", "moat", "m-failed", "m-attention",
  ]);
});

test('cellOps: "ran, stored nothing" is a muted bar, but only in a blank cell', () => {
  // An archive week that ran and found nothing eligible, or a dry run.
  assert.deepEqual(classes(cellOps(null, mark("ok"))), ["moat", "m-ok"]);
  // The same clean run under a filled body says nothing the body has not already said.
  assert.deepEqual(classes(cellOps("b-archived", mark("ok"))), ["b-archived"]);
});

test("cellOps: an archive week with data but no run this week is a body alone", () => {
  assert.deepEqual(classes(cellOps("b-pruned", NO_MARK)), ["b-pruned"]);
});

test("cellOps: nothing at all draws nothing at all", () => {
  assert.deepEqual(cellOps(null, NO_MARK), []);
});

test("cellOps: every op translates by the origin", () => {
  const at0 = cellOps("b-ok", mark("failed", "ok"));
  const at = cellOps("b-ok", mark("failed", "ok"), 100, 40);
  assert.equal(at.length, at0.length);
  for (let i = 0; i < at.length; i++) {
    assert.equal(at[i].x, at0[i].x + 100);
    assert.equal(at[i].y, at0[i].y + 40);
    assert.equal(at[i].w, at0[i].w);
    assert.equal(at[i].h, at0[i].h);
  }
});

// ── Geometry invariants ──────────────────────────────────────────────────────
// The moat is what makes the mark legible: measured against a filled body a bar is 1.0–1.7:1, and
// against the grid backdrop it is 3.4–5.6:1. If a mark ever escaped its moat, that would silently
// go away — so it is pinned rather than eyeballed.

test("geometry: the body fills the cell", () => {
  const [body] = cellOps("b-ok", NO_MARK);
  assert.deepEqual({ x: body.x, y: body.y, w: body.w, h: body.h }, { x: 0, y: 0, w: CELL_W, h: CELL_H });
});

test("geometry: every mark sits inside the moat with a 1px margin on all four sides", () => {
  // Body present or absent — a blank-bodied failure has to hold the same margins as a filled one.
  const cases: [string | null, ReturnType<typeof mark>][] = [
    ["b-ok", mark("failed")],
    [null, mark("ok")],
    ["b-ok", mark("failed", "ok")],
    ["b-ok", mark("failed", "attention")],
    [null, mark("failed", "attention")],
  ];
  for (const [body, m] of cases) {
    const ops = cellOps(body as never, m);
    const moat = ops.find((o) => o.cls === "moat")!;
    const marks = ops.filter((o) => o.cls.startsWith("m-"));
    assert.ok(marks.length > 0, "expected at least one mark op");
    for (const bar of marks) {
      assert.equal(bar.y - moat.y, 1, "1px above");
      assert.equal(moat.y + moat.h - (bar.y + bar.h), 1, "1px below");
      assert.ok(bar.x - moat.x >= 1, "1px or more to the left");
      assert.ok(moat.x + moat.w - (bar.x + bar.w) >= 1, "1px or more to the right");
    }
  }
});

test("geometry: the moat sits inside the cell", () => {
  const moat = cellOps(null, mark("failed")).find((o) => o.cls === "moat")!;
  assert.ok(moat.x >= 1 && moat.y >= 1);
  assert.ok(moat.x + moat.w <= CELL_W - 1);
  assert.ok(moat.y + moat.h <= CELL_H - 1);
});

test("geometry: the two dashes plus their gap are exactly one bar wide", () => {
  // No body, so the ops are [moat, …marks].
  const [, bar] = cellOps(null, mark("failed"));
  const [, first, second] = cellOps(null, mark("failed", "ok"));
  assert.equal(first.w, second.w, "the two dashes are equal");
  assert.equal(second.x + second.w, bar.x + bar.w, "they end where the single bar ends");
  assert.equal(first.x, bar.x, "and start where it starts");
  assert.equal(second.x - (first.x + first.w), 2, "with a 2px gap between them");
  assert.equal(first.h, bar.h);
});
