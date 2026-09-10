// ─────────────────────────────────────────────────────────────────────────────
// The "did it run clean?" channel of a dashboard cell.
//
// A cell's MARK answers one question — did the actions in this period run clean? — over however
// many runs the period holds. That reduces to a tiny value: the worst outcome, the second-worst,
// and how many DISTINCT outcomes there were. One distinct outcome draws one bar; two or more draw
// two dashes, which is the whole of what "mixed" needs to say. Counts, times and reasons live in
// the tooltip, so nothing here has to carry them.
//
// No imports, by design: this is shared by the Node builder and the browser bundle, and it is the
// one module both the grid and the legend swatches derive their marks from.
// ─────────────────────────────────────────────────────────────────────────────

/** One action's outcome, in severity order: `failed` > `attention` > `ok`. */
export type OutcomeCode = "ok" | "attention" | "failed";

/**
 * A cell's mark, reduced from its actions' codes.
 *
 * `worst`/`second` are the two most severe DISTINCT codes — not the first two runs. Three runs that
 * all failed are one distinct code and draw one bar; the tooltip is where "3 runs" is said.
 * `worst === null` means there were no actions at all, which draws nothing.
 */
export interface CellMark {
  worst: OutcomeCode | null;
  second: OutcomeCode | null;
  /** How many distinct codes are present (0, 1, 2 or 3). */
  codes: number;
}

/** The mark of a period in which nothing ran. */
export const NO_MARK: CellMark = { worst: null, second: null, codes: 0 };

const SEVERITY: Record<OutcomeCode, number> = { failed: 3, attention: 2, ok: 1 };

/**
 * Reduce a period's outcome codes to its mark. Order-independent and duplicate-insensitive: only
 * the SET of codes matters, because the mark is about what happened, not about when.
 */
export function summarizeOutcomes(codes: readonly OutcomeCode[]): CellMark {
  const distinct = [...new Set(codes)].sort((a, b) => SEVERITY[b] - SEVERITY[a]);
  return { worst: distinct[0] ?? null, second: distinct[1] ?? null, codes: distinct.length };
}
