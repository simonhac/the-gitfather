// ─────────────────────────────────────────────────────────────────────────────
// The one cell glyph, shared by a backup slot and an archive week.
//
// Every cell answers the same two questions in the same two places:
//
//   BODY  do we have data for this period?     blank = none · filled = yes · brighter step =
//                                              verified · grey = expired by policy (backups only)
//   MARK  did the actions in this period run   nothing = clean (or nothing ran) · one bar = the
//         clean?                               worst outcome · two dashes = more than one distinct
//                                              outcome · muted bar = ran clean but stored nothing
//
// Everything else — counts, rows, sizes, times, reasons, run links — is the tooltip's job. That is
// what lets one glyph serve both grids: the two cell kinds disagree about what their data MEANS,
// but not about whether they have any.
//
// This module is DOM-free on purpose. It emits a list of rectangles, not SVG nodes, so the grid,
// the legend swatches and the unit tests all derive their shapes from the same arithmetic — a
// legend swatch is by construction what the grid draws. It also owns the ONLY definition of the
// cell size, because the draw loop and the mouse hit-test both read it and must never disagree.
// ─────────────────────────────────────────────────────────────────────────────

import type { ArchiveCell, ArchiveCellState, BackupBodyState, ArchiveBodyState } from "./backupTypes.js";
import { summarizeOutcomes, type CellMark, type OutcomeCode } from "./outcomes.js";

// ── Geometry ─────────────────────────────────────────────────────────────────
// Width and height are separate constants so a non-square cell can be tried by editing two
// numbers; everything below derives from them, including the hit-test.

export const CELL_W = 20;
export const CELL_H = 20;
export const CELL_RX = 4;
/** Space between cells. Flat fills do the separating, so there is no per-cell stroke. */
export const GAP = 3;
export const PITCH_X = CELL_W + GAP;
export const PITCH_Y = CELL_H + GAP;
/** Wider than the grid pitch: an archive column carries a "T1" header, and those touch at PITCH_X. */
export const ARCHIVE_PITCH = CELL_W + 6;

/**
 * The mark's backdrop-coloured moat, and why it is load-bearing rather than decoration: a bar drawn
 * straight onto a filled body measures 1.0–1.7:1 against it (red on ok-green is 1.11:1), which is
 * no contrast at all. Sitting in a moat, the bar reads against the grid backdrop instead — red
 * 3.43:1 light / 5.01:1 dark, muted 4.35:1 / 5.64:1 — so the same mark works on every body colour.
 */
const MOAT_INSET = 2;
const MOAT_H = 5;
const MOAT_RX = 2.5;
const BAR_INSET = 3;
const BAR_H = 3;
const BAR_RX = 1.5;
/** Gap between the two dashes of a mixed mark. */
const DASH_GAP = 2;

/** Clearance between the moat and the cell's bottom edge. */
const BOTTOM_INSET = 3;

const MOAT_W = CELL_W - MOAT_INSET * 2;
const BAR_W = CELL_W - BAR_INSET * 2;
const DASH_W = (BAR_W - DASH_GAP) / 2;
// Low in the cell, and in the SAME place in every cell, so the eye can scan a column of marks
// without also tracking their position. The bar is centred in the moat, leaving the 1px ring.
const MOAT_Y = CELL_H - BOTTOM_INSET - MOAT_H;
const BAR_Y = MOAT_Y + (MOAT_H - BAR_H) / 2;

// ── Classes ──────────────────────────────────────────────────────────────────
// Colours are CSS classes, never attributes: that is what lets the theme switch recolour a rendered
// grid, and what keeps one palette declaration serving both the SVG and the tooltip's dots.

export type BodyClass = "b-ok" | "b-verified" | "b-expired" | "b-archived" | "b-pruned";
export type MarkClass = "m-ok" | "m-attention" | "m-failed";

const MARK_CLASS: Record<OutcomeCode, MarkClass> = {
  ok: "m-ok",
  attention: "m-attention",
  failed: "m-failed",
};

/** One rectangle to paint. `cls` carries the colour; the geometry is already absolute. */
export interface RectOp {
  cls: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
}

// ── The glyph ────────────────────────────────────────────────────────────────

/**
 * The rectangles for one cell, in paint order, translated to (x, y).
 *
 * The mark is drawn only when it has something to say. A clean run under a filled body says nothing
 * the body has not already said, so it draws nothing — which is what keeps a healthy year of
 * backups reading as a calm block of green rather than a field of bars.
 */
export function cellOps(body: BodyClass | null, mark: CellMark, x = 0, y = 0): RectOp[] {
  const ops: RectOp[] = [];
  if (body) ops.push({ cls: body, x, y, w: CELL_W, h: CELL_H, rx: CELL_RX });

  if (mark.worst === null) return ops; // nothing ran
  if (mark.codes === 1 && mark.worst === "ok" && body) return ops; // clean run, filled body

  ops.push({ cls: "moat", x: x + MOAT_INSET, y: y + MOAT_Y, w: MOAT_W, h: MOAT_H, rx: MOAT_RX });

  if (mark.codes >= 2) {
    // Two dashes = "the runs in this period disagreed". A single bar cannot say that, and a corner
    // wedge (the shape this replaced) could not either.
    ops.push({ cls: MARK_CLASS[mark.worst], x: x + BAR_INSET, y: y + BAR_Y, w: DASH_W, h: BAR_H, rx: BAR_RX });
    ops.push({
      cls: MARK_CLASS[mark.second ?? "ok"],
      x: x + BAR_INSET + DASH_W + DASH_GAP,
      y: y + BAR_Y,
      w: DASH_W,
      h: BAR_H,
      rx: BAR_RX,
    });
  } else {
    ops.push({ cls: MARK_CLASS[mark.worst], x: x + BAR_INSET, y: y + BAR_Y, w: BAR_W, h: BAR_H, rx: BAR_RX });
  }
  return ops;
}

// ── Bodies ───────────────────────────────────────────────────────────────────

/**
 * The class for a body state — the ONE place a lifecycle state becomes a colour, for both cell
 * kinds. Backups run `ok → verified` with `expired` as the recessive end; archives run
 * `archived → pruned`, where the brighter step means "verified at prune" for the same reason the
 * brighter green does. null (nothing held) draws nothing at all.
 */
export function bodyClass(state: BackupBodyState | ArchiveBodyState | null): BodyClass | null {
  switch (state) {
    case "ok":
      return "b-ok";
    case "verified":
      return "b-verified";
    case "expired":
      return "b-expired";
    case "archived":
      return "b-archived";
    case "pruned":
      return "b-pruned";
    default:
      return null;
  }
}

// ── Archive weeks ────────────────────────────────────────────────────────────

/**
 * One archive run's outcome code. `deriveArchiveState` has already done the hard part — it checks
 * refusals and anomalies BEFORE `ok`, because archive-table.ts folds them into `ok` and a refusal
 * is a deliberate decline, not a breakage — so this is a straight mapping. `archived` and `quiet`
 * are both clean runs; the difference between them is whether anything was stored, which is the
 * BODY's question, not the mark's.
 */
export function archiveCode(sr: { state: ArchiveCellState }): OutcomeCode {
  if (sr.state === "failed") return "failed";
  if (sr.state === "attention") return "attention";
  return "ok";
}

/**
 * The body of an archive week.
 *
 * NOTE the subject: today this is derived from the RUNS, so it says "the archiver moved rows during
 * this week" — which is what the blue cell has always meant. The data-week view (`_index/`, where
 * the body would instead mean "the rows DATED this week are archived / pruned") is the next change,
 * and it replaces the source here without touching the glyph.
 */
export function archiveBody(cell: Pick<ArchiveCell, "successState">): BodyClass | null {
  return bodyClass(cell.successState === "archived" ? "archived" : null);
}

export function archiveMark(cell: Pick<ArchiveCell, "runs">): CellMark {
  return summarizeOutcomes(cell.runs.map(archiveCode));
}
