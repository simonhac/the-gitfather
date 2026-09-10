// ─────────────────────────────────────────────────────────────────────────────
// Browser entry for the backup-history dashboard. Reads the scrubbed PublicPayload
// from the inlined <script id="backup-data">, builds the GFS grid (shared logic),
// and renders an SVG heatmap + legend + summary into #app. Bundled into a single
// inline <script> by build-dashboard.ts (esbuild) — no runtime deps, no network.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildBackupGrid,
  buildArchiveColumns,
  summarize,
  summarizeArchives,
  backupCode,
  archiveCode,
  runBodyState,
  archiveStoredBytes,
  formatInTz,
  slotApproxDate,
  storedBytes,
  r2MonthlyCostUsd,
  WEEKDAY_LABELS,
} from "../scripts/lib/backupHistory.js";
import {
  SLOTS_PER_DAY,
  slotCadence,
  slotCadenceAdjective,
  retentionBullets,
  archiveBlurb,
  DAYS_PER_WEEK,
  COLS_PER_WEEK,
  DISPLAY_TZ,
  DEFAULT_RETENTION,
  maxRetained,
  type PublicPayload,
  type PublicArchiveRun,
  type BackupCellState,
  type BackupCell,
  type SlotRun,
  type ArchiveCellState,
  type ArchiveBodyState,
  type ArchiveCell,
  type ArchiveSlotRun,
} from "../scripts/lib/backupTypes.js";
import {
  CELL_W,
  CELL_H,
  GAP,
  PITCH_X,
  PITCH_Y,
  ARCHIVE_PITCH,
  cellOps,
  bodyClass,
  type BodyClass,
  type RectOp,
} from "../scripts/lib/cellGlyph.js";
import { summarizeOutcomes, type CellMark, type OutcomeCode, NO_MARK } from "../scripts/lib/outcomes.js";
import { themeControl } from "./theme.js";

const SVGNS = "http://www.w3.org/2000/svg";
// Cell geometry lives in cellGlyph.ts — the draw loop, the legend swatches and the mouse hit-test
// all read it from there, so they cannot drift apart. Only the axes belong to this file.
const LEFT_AXIS = 72; // fits "DD MMM YY" at the 11px monospace axis size
const TOP_AXIS = 24;
const WEEKS = 52;
const ARCHIVE_GUTTER = 10; // breathing room between the backup grid and the archive block

// Colours are CSS classes, not values — see template.html. Nothing in this file may resolve a
// palette at module load: that is what used to freeze the grid in its load-time theme while the
// rest of the page followed the OS.

// The `2hourly` key is the frozen R2 prefix, not the cadence — label it from the profile's slot
// width so a tooltip cannot say "2-hourly" about an 8-hourly backup.
const TIER_LABEL: Record<string, string> = {
  "2hourly": slotCadenceAdjective(), daily: "daily", weekly: "weekly", monthly: "monthly",
};
const STATE_LABEL: Record<BackupCellState, string> = {
  empty: "No backup", failed: "Failed", expired: "Expired (was OK)", ok: "Backup OK",
  verified: "Restore-verified", unverified: "Drill failed",
};

const ARCHIVE_STATE_LABEL: Record<ArchiveCellState, string> = {
  archived: "Archived", quiet: "Nothing to archive", attention: "Needs a look", failed: "Failed",
};

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
function elem(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const payload: PublicPayload = JSON.parse(
  (document.getElementById("backup-data") as HTMLScriptElement).textContent || "{}",
);
const now = new Date(payload.generatedAt);
const grid = buildBackupGrid(payload, now, WEEKS);
const stats = summarize(grid);
// null for a profile that archives nothing — every archive-conditional block below then no-ops, and
// the page renders exactly as it did before these columns existed.
const archiveCols = buildArchiveColumns(payload, now, WEEKS);
const archiveStats = archiveCols ? summarizeArchives(archiveCols) : null;
/** Short table name → its column label, e.g. "api_logs" → "T1 api_logs". */
const archiveLabel = new Map<string, string>((archiveCols?.tables ?? []).map((t, i) => [t, `T${i + 1} ${t}`]));
const archiveIndex = new Map<string, number>((archiveCols?.tables ?? []).map((t, i) => [t, i]));

const app = document.getElementById("app")!;

// ── Header ───────────────────────────────────────────────────────────────────
// A flex row: the prose column on the left, the theme pill top-right.
const header = elem("header", "header");
const headerText = elem("div", "header-text");
headerText.appendChild(elem("h1", undefined, `${payload.label} — backup history`));
const R = payload.retention ?? DEFAULT_RETENTION;

// The GFS ladder is four parallel clauses, which is one clause too many for a sentence — as a
// paragraph the windows ran together and the reader had to count commas to tell which tier kept
// what. Rendered as a list instead; the strings come from retentionBullets/slotCadence so the
// wording stays unit-tested rather than eyeballed on a published page.
const { lead, emphasis } = slotCadence();
const intro = elem("p", "subtitle");
intro.append(
  `This grid shows every off-site Postgres backup over the last ${WEEKS} weeks — ${lead} `,
  elem("em", undefined, emphasis),
  ".",
);
headerText.appendChild(intro);
headerText.appendChild(elem("p", "subtitle", "Older copies thin out on a Grandfather–Father–Son schedule:"));
const ladder = elem("ul", "tiers");
for (const bullet of retentionBullets(R)) ladder.appendChild(elem("li", undefined, bullet));
headerText.appendChild(ladder);
headerText.appendChild(elem("p", "subtitle", `…at its fullest about ${maxRetained(R)} backups at once.`));
if (archiveCols && payload.archive) {
  const { lead, emphasis, tail } = archiveBlurb(payload.archive.tables);
  const blurb = elem("p", "subtitle");
  blurb.append(lead, elem("em", undefined, emphasis), tail);
  headerText.appendChild(blurb);
}
// The paragraph that used to explain the colours here is gone: the legend is now the explanation,
// and a key that has to be paraphrased in prose above it is a key that has not done its job.
header.appendChild(headerText);
header.appendChild(themeControl());
app.appendChild(header);

// ── Summary stats ────────────────────────────────────────────────────────────
const stored = storedBytes(payload, now.getTime());
const costMo = r2MonthlyCostUsd(stored);
// R2 bills in decimal GB, so show stored in decimal GB too (keeps it consistent with Est. cost).
const storedGb = stored / 1_000_000_000;
const storedLabel = `${storedGb >= 100 ? storedGb.toFixed(0) : storedGb >= 10 ? storedGb.toFixed(1) : storedGb.toFixed(2)} GB`;
const statsRow = elem("div", "stats");
// Two tidy rows of four: top = recency + scale, bottom = the outcome breakdown.
const statDefs: { label: string; value: string | number; hint?: string; cls?: string }[] = [
  { label: "Latest run", value: stats.latestLabel ?? "—", cls: "text" },
  {
    label: "Stored",
    value: storedLabel,
    // Both figures fold in the archive objects — same bucket, same bill — but only say so when
    // there are any, so a profile that archives nothing keeps the wording it has always had.
    hint:
      "Live data in R2 (decimal GB) across all GFS tier copies — each tier is a separate object." +
      (archiveCols ? " Includes every archive object ever written." : ""),
  },
  {
    label: "Est. cost",
    value: `$${costMo.toFixed(2)}/mo`,
    hint:
      "R2 Standard storage at $0.015/GB-month after the 10 GB-month free allowance; egress is free." +
      (archiveCols ? " Covers backups and archives alike — one bucket, one bill." : ""),
  },
  { label: "Total runs", value: stats.total },
  { label: "Verified", value: stats.verified, cls: stats.verified ? "pos" : undefined },
  { label: "Retained", value: stats.ok + stats.verified },
  { label: "Expired", value: stats.expired },
  { label: "Failed", value: stats.failed, cls: stats.failed ? "bad" : undefined },
];
// A third row of four, only when the profile archives something. These are about rows leaving
// Postgres, so they stay out of the backup counts above: an archive run is not a backup run.
if (archiveStats) {
  statDefs.push(
    {
      label: "Rows archived",
      value: archiveStats.rowsArchived.toLocaleString("en-GB"),
      // Two subjects, so the second one is a hint rather than a fourth row of cards: the value
      // counts rows the RUNS in this window moved; the hint counts table-weeks whose rows are in
      // the archive, which is what the blue cells show.
      hint: `Rows written to archive objects over the last ${WEEKS} weeks. ` +
        `${archiveStats.weeksArchived.toLocaleString("en-GB")} table-week(s) in the visible window are archived.`,
    },
    {
      label: "Rows pruned",
      value: archiveStats.rowsPruned.toLocaleString("en-GB"),
      hint: `Rows deleted from the database after archiving, over the last ${WEEKS} weeks. ` +
        `${archiveStats.weeksPruned.toLocaleString("en-GB")} table-week(s) in the visible window are pruned.`,
    },
    { label: "Archive stored", value: formatBytes(archiveStoredBytes(payload)), hint: "Every archive object ever written. Archives have no lifecycle rule — nothing here expires." },
    { label: "Archive issues", value: archiveStats.issues, cls: archiveStats.issues ? "bad" : undefined },
  );
}
for (const { label, value, hint, cls } of statDefs) {
  const card = elem("div", "stat");
  if (hint) card.title = hint;
  card.appendChild(elem("div", "stat-label", label));
  card.appendChild(elem("div", `stat-value${cls ? ` ${cls}` : ""}`, String(value)));
  statsRow.appendChild(card);
}
app.appendChild(statsRow);

// ── Heatmap card (legend + grid share one surface) ───────────────────────────
const card = elem("div", "card");
app.appendChild(card);

// ── Legend ───────────────────────────────────────────────────────────────────
// Two headed groups, then the table key. The heads carry the grammar: DATA is about what we hold,
// RUNS is about how the jobs went, and every cell answers both in the same two places.
const legend = elem("div", "legend");

/**
 * One key swatch: the SAME cellOps() the grid uses, on a backdrop tile, scaled to 16px. Drawing it
 * from the glyph rather than from a CSS square is the point — a swatch is then by construction what
 * the grid draws, so the key cannot quietly stop matching the picture. The tile matters too: without
 * it "None" would be invisible on a white card, and so would grey "Expired".
 */
function swatch(body: BodyClass | null, mark: CellMark): SVGElement {
  // Rendered at the grid's own size rather than scaled down: the marks are 3px tall, and shrinking
  // them to fit a smaller swatch is exactly the thing that makes a key stop matching its picture.
  const el = svg("svg", {
    class: "legend-swatch", width: CELL_W, height: CELL_H, viewBox: `0 0 ${CELL_W} ${CELL_H}`, "aria-hidden": "true",
  });
  el.appendChild(svg("rect", { class: "backdrop", x: 0, y: 0, width: CELL_W, height: CELL_H, rx: 4 }));
  appendOps(el, cellOps(body, mark));
  return el;
}

/** A mark of exactly one code — what most legend entries need. */
const one = (code: OutcomeCode): CellMark => ({ worst: code, second: null, codes: 1 });

function legendGroup(head: string, items: [string, BodyClass | null, CellMark][]): void {
  const group = elem("div", "legend-group");
  group.appendChild(elem("span", "legend-head", head));
  for (const [label, body, mark] of items) {
    const item = elem("div", "legend-item");
    item.appendChild(swatch(body, mark));
    item.appendChild(document.createTextNode(label));
    group.appendChild(item);
  }
  legend.appendChild(group);
}

const dataItems: [string, BodyClass | null, CellMark][] = [
  ["Backup", "b-ok", NO_MARK],
  ["Verified", "b-verified", NO_MARK],
  ["Expired", "b-expired", NO_MARK],
];
// The archive body entries only exist when the profile archives something.
if (archiveCols) dataItems.push(["Archived", "b-archived", NO_MARK], ["Pruned", "b-pruned", NO_MARK]);
dataItems.push(["Nothing", null, NO_MARK]);
legendGroup("Data", dataItems);

legendGroup("Runs", [
  ["Failed", null, one("failed")],
  ["Needs a look", "b-ok", one("attention")],
  ["Mixed outcomes", "b-ok", { worst: "failed", second: "ok", codes: 2 }],
  // A clean run with nothing beneath it. Under the two-channel split this no longer means "stored
  // nothing" — an archiver run stores some OTHER week's rows — it means the run went clean and the
  // body has nothing of its own to say.
  ["Ran clean", null, one("ok")],
]);

// The Tn → table-name key. Mono, so it reads as the label it is rather than as prose.
if (archiveCols) {
  const group = elem("div", "legend-group");
  group.appendChild(elem("span", "legend-head", "Tables"));
  for (const table of archiveCols.tables) {
    group.appendChild(elem("div", "legend-item legend-table", archiveLabel.get(table)!));
  }
  legend.appendChild(group);
}
card.appendChild(legend);

// ── Heatmap SVG ──────────────────────────────────────────────────────────────
const gridWidth = COLS_PER_WEEK * PITCH_X;
const gridHeight = grid.weeks * PITCH_Y;
// The archive block shares the row pitch but sits on its own backdrop past a gutter, so it reads as
// a sibling panel rather than an eighth day. With no archived tables it takes no width at all and
// the viewBox is byte-for-byte what it was.
const archiveX0 = LEFT_AXIS + gridWidth + ARCHIVE_GUTTER;
const archiveWidth = archiveCols ? archiveCols.tables.length * ARCHIVE_PITCH : 0;
const totalWidth = (archiveCols ? archiveX0 + archiveWidth : LEFT_AXIS + gridWidth) + 2;
const totalHeight = TOP_AXIS + gridHeight + 2;

const scroll = elem("div", "scroll");
// Scale-to-fit: a viewBox lets the grid shrink to the container width (never upscaling past
// its natural size), so all 7 days are visible without horizontal scrolling.
const root = svg("svg", {
  viewBox: `0 0 ${totalWidth} ${totalHeight}`, width: "100%", preserveAspectRatio: "xMinYMin meet", class: "heatmap",
}) as SVGSVGElement;
root.style.maxWidth = `${totalWidth}px`;
root.style.height = "auto";
// The page column is sized to the grid rather than to a fixed 1220px, and centred. A heatmap is
// only as wide as its data — at an 8-hourly cadence about 620px — and letting the card run to 1220
// left two thirds of it as blank white to the right of the last column, which reads as a rendering
// fault rather than as space.
//
// CSS cannot measure the SVG, so the width is handed over as a token. It goes on #app, not on the
// card, because the header, the stat cards, the legend and the footer all have to end up the same
// width as the grid and aligned with it: one column, sized by the one thing on the page that has an
// intrinsic width. The `min()` in the rule keeps a denser cadence from overflowing the page.
app.style.setProperty("--grid-w", `${totalWidth}px`);

// Weekday headers
WEEKDAY_LABELS.forEach((label, day) => {
  const t = svg("text", {
    x: LEFT_AXIS + (day * SLOTS_PER_DAY + SLOTS_PER_DAY / 2) * PITCH_X,
    y: TOP_AXIS - 9, "text-anchor": "middle", class: "axis",
  });
  t.textContent = label;
  root.appendChild(t);
});

// Week-start row labels
grid.rows.forEach((row, r) => {
  const t = svg("text", {
    x: LEFT_AXIS - 9, y: TOP_AXIS + r * PITCH_Y + CELL_H - 6, "text-anchor": "end", class: "axis",
  });
  t.textContent = row.weekStartLabel;
  root.appendChild(t);
});

// Backdrop + day-delineation lines
root.appendChild(svg("rect", {
  class: "backdrop", x: LEFT_AXIS, y: TOP_AXIS, width: gridWidth, height: gridHeight, rx: 5,
}));
for (let i = 1; i < DAYS_PER_WEEK; i++) {
  const x = LEFT_AXIS + i * SLOTS_PER_DAY * PITCH_X - GAP / 2;
  root.appendChild(svg("line", { class: "gridline", x1: x, y1: TOP_AXIS, x2: x, y2: TOP_AXIS + gridHeight }));
}

// Archive backdrop + T1…Tn column headers (same style and baseline as Mon…Sun).
if (archiveCols) {
  root.appendChild(svg("rect", {
    class: "backdrop", x: archiveX0, y: TOP_AXIS, width: archiveWidth, height: gridHeight, rx: 5,
  }));
  archiveCols.tables.forEach((_table, i) => {
    const t = svg("text", {
      x: archiveX0 + (i + 0.5) * ARCHIVE_PITCH, y: TOP_AXIS - 9,
      "text-anchor": "middle", class: "axis",
    });
    t.textContent = `T${i + 1}`;
    root.appendChild(t);
  });
}

// Where a cell sits, in viewBox user units. The draw loops and the hover anchor both go through
// these, so the beak can never point somewhere the cell isn't.
const backupCellX = (col: number): number => LEFT_AXIS + col * PITCH_X + GAP / 2;
const archiveCellX = (i: number): number => archiveX0 + i * ARCHIVE_PITCH + (ARCHIVE_PITCH - CELL_W) / 2;
const cellY = (r: number): number => TOP_AXIS + r * PITCH_Y + GAP / 2;

// Cells. One glyph for both grids — see cellGlyph.ts for what the body and the mark each say.
// A cell is drawn whenever it has anything to say: a failed-only slot has no body at all, just a
// red bar in an otherwise blank square.

/** Paint a list of rectangles into an SVG parent. */
function appendOps(target: SVGElement, ops: RectOp[]): void {
  for (const op of ops) {
    target.appendChild(svg("rect", { class: op.cls, x: op.x, y: op.y, width: op.w, height: op.h, rx: op.rx }));
  }
}

/**
 * One cell, wrapped in a `<g>` so CSS can style it as a unit on hover, with a transparent hit rect
 * on top. The hit rect is last (so it is over everything) and full-size (so a cell whose body is
 * blank — a failed run, a quiet archive week — is still hoverable across its whole square).
 */
function drawGlyph(body: BodyClass | null, mark: CellMark, x: number, y: number): void {
  const g = svg("g", { class: "cell" });
  appendOps(g, cellOps(body, mark, x, y));
  g.appendChild(svg("rect", { class: "cell-hit", x, y, width: CELL_W, height: CELL_H, rx: 4 }));
  root.appendChild(g);
}

grid.rows.forEach((row, r) => {
  for (const cell of row.cells.values()) {
    drawGlyph(bodyClass(cell.body), cell.mark, backupCellX(cell.col), cellY(r));
  }
});

archiveCols?.rows.forEach((cells, r) => {
  for (const cell of cells.values()) {
    const i = archiveIndex.get(cell.table);
    // Cells stay cell-sized and centred in the wider archive column; only the row pitch is shared.
    // The body is the rows DATED this week; the mark is the runs that happened in it.
    if (i != null) drawGlyph(bodyClass(cell.data?.state ?? null), cell.mark, archiveCellX(i), cellY(r));
  }
});

scroll.appendChild(root);
card.appendChild(scroll);

// ── Hover tooltip + click-to-choose popover ──────────────────────────────────
// Hover shows a read-only tip anchored to the CELL — not to the pointer — with a beak pointing back
// at it. Anchoring to the cell is what makes the panel legible without a cursor: a screenshot has no
// pointer in it, so a tip floating near an 11px square would otherwise be about nothing in
// particular. It also stops the panel jittering as the pointer moves within one cell.
//
// Clicking a slot opens its GitHub run; when a slot holds several runs, clicking instead pins an
// interactive chooser so the user can pick which run to open (each run is its own link).
const tip = elem("div", "tip");
tip.style.display = "none";
const popover = elem("div", "tip pinned");
popover.style.display = "none";
document.body.appendChild(tip);
document.body.appendChild(popover);

/** A cell's box in client (viewport) pixels — what a panel and its beak are placed against. */
interface Anchor {
  cx: number;
  top: number;
  bottom: number;
}

/** How far the beak sticks out past the panel's edge (half its rotated diagonal, less the border). */
const BEAK = 6;
/** Clearance between the cell and the panel, and between the panel and the viewport edge. */
const PANEL_GAP = 3;
const EDGE = 8;

/**
 * Place a panel against a cell: below it when there is room, above it when there isn't, centred on
 * the cell and clamped to the viewport — with the beak shifted by whatever the clamp took, so it
 * keeps pointing at the cell even when the panel has been pushed sideways.
 */
function placePanel(el: HTMLElement, html: string, anchor: Anchor): void {
  el.innerHTML = html;
  // Measure from the left edge, not from wherever the panel last sat. These are fixed-position
  // shrink-to-fit boxes with `right: auto`, so their width depends on the space between `left` and
  // the viewport edge: measuring after positioning yields a width the panel then reflows away from,
  // and the clamp below under-corrects by exactly that error, letting the panel touch the edge.
  el.style.left = "0px";
  el.style.top = "0px";
  el.style.display = "block"; // must be laid out before offsetWidth/offsetHeight mean anything
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const below = anchor.bottom + BEAK + PANEL_GAP + h <= window.innerHeight - EDGE;
  const left = Math.max(EDGE, Math.min(anchor.cx - w / 2, window.innerWidth - w - EDGE));
  el.style.left = `${left}px`;
  el.style.top = `${below ? anchor.bottom + BEAK + PANEL_GAP : anchor.top - BEAK - PANEL_GAP - h}px`;
  el.classList.toggle("above", !below);
  // Keep the beak clear of the rounded corners even if that means it stops short of the cell.
  el.style.setProperty("--beak-x", `${Math.max(12, Math.min(anchor.cx - left, w - 12))}px`);
}

// The two blocks hit-test into different cell types, so the hovered thing is a tagged union rather
// than two variables that could disagree about which tooltip is on screen.
type Hover =
  | { kind: "backup"; cell: BackupCell; anchor: Anchor }
  | { kind: "archive"; cell: ArchiveCell; anchor: Anchor };
let hover: Hover | null = null;
let pinned = false;

root.addEventListener("mousemove", (e) => {
  if (pinned) return; // chooser is open — leave it be
  const rect = root.getBoundingClientRect();
  // The SVG may be scaled to fit; map cursor px back into viewBox user units.
  const scale = rect.width / totalWidth || 1;
  const ux = (e.clientX - rect.left) / scale;
  const r = Math.floor(((e.clientY - rect.top) / scale - TOP_AXIS) / PITCH_Y);
  if (r < 0 || r >= grid.weeks) {
    hide();
    return;
  }
  // The cell's own box, in client px — the panel and its beak hang off this, not off the pointer.
  const anchorAt = (cellUx: number): Anchor => ({
    cx: rect.left + (cellUx + CELL_W / 2) * scale,
    top: rect.top + cellY(r) * scale,
    bottom: rect.top + (cellY(r) + CELL_H) * scale,
  });

  const col = Math.floor((ux - LEFT_AXIS) / PITCH_X);
  const acol = Math.floor((ux - archiveX0) / ARCHIVE_PITCH);
  let html: string;
  let anchor: Anchor;
  if (col >= 0 && col < COLS_PER_WEEK) {
    const cell = grid.rows[r]?.cells.get(col) ?? null;
    anchor = anchorAt(backupCellX(col));
    hover = cell ? { kind: "backup", cell, anchor } : null;
    html = cell ? cellHtml(cell) : emptyHtml(r, col);
  } else if (archiveCols && acol >= 0 && acol < archiveCols.tables.length) {
    const table = archiveCols.tables[acol];
    const cell = archiveCols.rows[r]?.get(table) ?? null;
    anchor = anchorAt(archiveCellX(acol));
    hover = cell ? { kind: "archive", cell, anchor } : null;
    html = archiveTipHtml(r, table, cell);
  } else {
    hide(); // the gutter between the blocks, or past either edge
    return;
  }
  root.style.cursor = clickable(hover?.cell ?? null) ? "pointer" : "default";
  placePanel(tip, html, anchor);
});
root.addEventListener("mouseleave", hide);

root.addEventListener("click", (e) => {
  if (pinned) { closeChooser(); e.stopPropagation(); return; }
  if (!hover) return;
  const cell: Linked = hover.cell;
  const linked = cell.runs.filter((sr) => sr.run.runUrl);
  if (cell.runs.length > 1 && linked.length > 0) {
    // Several runs here — let the user choose which one to open.
    openChooser(hover.kind === "archive" ? archiveChooserHtml(hover.cell) : chooserHtml(hover.cell), hover.anchor);
    e.stopPropagation();
    return;
  }
  const url = latestUrl(cell);
  if (url) window.open(url, "_blank", "noopener");
});

// Dismiss the chooser on link-click, outside-click, or Escape.
popover.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a.tip-link")) closeChooser();
});
document.addEventListener("click", (e) => {
  if (pinned && !popover.contains(e.target as Node)) closeChooser();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && pinned) closeChooser();
});

function openChooser(html: string, anchor: Anchor) {
  hide();
  placePanel(popover, html, anchor);
  pinned = true;
}
function closeChooser() {
  popover.style.display = "none";
  pinned = false;
}

/** The shape both cell kinds share for link purposes — so neither needs its own copy of these. */
interface Linked {
  runs: { run: { runUrl: string | null } }[];
}
/**
 * Run link of the latest run in a cell (cells are time-sorted), for the single-run click. `.at(-1)`
 * rather than `[length - 1]`: a cell is about to be able to exist with data but NO runs, and the
 * indexed form throws on that rather than returning null.
 */
function latestUrl(cell: Linked | null): string | null {
  return cell?.runs.at(-1)?.run.runUrl ?? null;
}
/** A cell is clickable if any of its runs has a GitHub run link. */
function clickable(cell: Linked | null): boolean {
  return !!cell && cell.runs.some((sr) => sr.run.runUrl != null);
}

function hide() {
  tip.style.display = "none";
  hover = null;
}

// Tooltip glyphs take the SAME classes as the grid, so a dot and the cell it describes can never
// disagree about colour — and both follow the theme switch, because neither carries a value.
/** A data dot: a small square in a body colour. */
function dot(cls: BodyClass): string {
  return `<span class="dot ${cls}"></span>`;
}
/** A run mark: the same pill the grid draws, in the run's outcome colour. */
function markDot(code: OutcomeCode): string {
  return `<span class="dot mark m-${code}"></span>`;
}
/** The body class a single run would paint, or null when it painted none (a failed run). */
function runBody(state: BackupCellState): BodyClass | null {
  return bodyClass(runBodyState(state));
}
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/**
 * The "N actions · M not clean" summary for a period holding more than one run — the line the cell's
 * two-dash mark is short for. Its pill is the worst code, which is the dash the eye lands on first.
 */
function actionsLine(codes: OutcomeCode[]): string {
  const worst = summarizeOutcomes(codes).worst ?? "ok";
  const bad = codes.filter((c) => c !== "ok").length;
  const tail = bad > 0 ? `${bad} not clean` : "all clean";
  return `<div class="tip-state">${markDot(worst)}<span class="tip-count">${codes.length} actions · ${tail}</span></div>`;
}

function cellHtml(cell: BackupCell): string {
  const lines: string[] = [];
  const multiple = cell.runs.length > 1;
  if (multiple) {
    // Several runs in one slot — list each, so nothing is hidden behind a single mark.
    lines.push(`<div class="tip-when">${cell.runs.length} runs this slot</div>`);
    for (const sr of cell.runs) {
      const size = sr.run.bytes != null ? ` · ${formatBytes(sr.run.bytes)}` : "";
      lines.push(`<div class="tip-state">${markDot(backupCode(sr))}${esc(sr.whenLabel)} · ${STATE_LABEL[sr.state]}${size}</div>`);
    }
  } else {
    const sr = cell.runs[0];
    const b = runBody(sr.state);
    lines.push(`<div class="tip-when">${esc(sr.whenLabel)}</div>`);
    // The body line first (what we HOLD), then what the run did — the same order as the cell.
    lines.push(`<div class="tip-state">${b ? dot(b) : markDot(backupCode(sr))}${STATE_LABEL[sr.state]}</div>`);
    if (sr.run.ok) lines.push(`<div class="tip-muted">${formatBytes(sr.run.bytes)} · ${sr.run.tiers.map((t) => TIER_LABEL[t] ?? t).join(", ")}</div>`);
    if (sr.state === "expired") lines.push(`<div class="tip-muted">Object has aged out of R2 retention.</div>`);
    const v = sr.verification;
    if (v?.ok) {
      const what = v.kind === "hash"
        ? "Byte-verified (checksum match)"
        : `Drill restored &amp; verified${v.ratio != null ? ` (${(v.ratio * 100).toFixed(0)}% of live rows)` : ""}`;
      lines.push(`<div class="tip-muted">${what}.</div>`);
    } else if (v && !v.ok) {
      lines.push(`<div class="tip-fail">${v.kind === "hash" ? "Integrity check FAILED" : "Restore drill FAILED"} for this dump.</div>`);
    }
    if (!sr.run.ok) lines.push(`<div class="tip-fail">Backup failed.</div>`);
  }
  if (multiple) lines.push(actionsLine(cell.runs.map(backupCode)));
  if (clickable(cell)) {
    lines.push(`<div class="tip-hint">${multiple ? "Click to choose a run to open ↗" : "Click to open the GitHub run ↗"}</div>`);
  }
  return lines.join("");
}
function emptyHtml(r: number, col: number): string {
  const weekday = Math.floor(col / SLOTS_PER_DAY);
  const slot = col % SLOTS_PER_DAY;
  const label = formatInTz(slotApproxDate(grid.rows[r].weekStartOrdinal, weekday, slot));
  return `<div class="tip-when">${esc(label)}</div><div class="tip-muted">No backup at this slot</div>`;
}

// Pinned chooser shown when a slot holds several runs: one clickable row per run.
/** One chooser row — a link when the run has a GitHub URL, an inert row when it doesn't. */
function linkRow(dotHtml: string, text: string, runUrl: string | null): string {
  const label = `${dotHtml}<span class="tip-run-label">${text}</span>`;
  return runUrl
    ? `<a class="tip-link" href="${esc(runUrl)}" target="_blank" rel="noopener">${label}<span class="tip-go">↗</span></a>`
    : `<div class="tip-row">${label}<span class="tip-go tip-nolink">no run link</span></div>`;
}
function runLink(sr: SlotRun): string {
  const size = sr.run.bytes != null ? ` · ${formatBytes(sr.run.bytes)}` : "";
  return linkRow(markDot(backupCode(sr)), `${esc(sr.whenLabel)} · ${STATE_LABEL[sr.state]}${size}`, sr.run.runUrl);
}
function chooserHtml(cell: BackupCell): string {
  const lines = [
    `<div class="tip-when">${cell.runs.length} runs this slot</div>`,
    `<div class="tip-muted">Open a run on GitHub:</div>`,
    ...cell.runs.map(runLink),
    `<div class="tip-hint">Esc or click away to dismiss</div>`,
  ];
  return lines.join("");
}

// ── Archive tooltips ─────────────────────────────────────────────────────────

const weeksWord = (n: number): string => `${n} week${n === 1 ? "" : "s"}`;
const rowsWord = (n: number): string => `${n.toLocaleString("en-GB")} row${n === 1 ? "" : "s"}`;

/**
 * An archive run's glyph. Always an outcome pill, never a data square: a run belongs to the mark
 * channel, and the week it moved rows for is almost never the week it ran in.
 */
function archiveDot(state: ArchiveCellState): string {
  return markDot(archiveCode({ state }));
}

/** What this run actually did, in one line. */
function archiveHeadline(sr: ArchiveSlotRun): string {
  const r = sr.run;
  if (sr.state === "quiet") {
    return r.dryRun !== "none" ? `Dry run (${r.dryRun})` : "Ran — nothing eligible";
  }
  if (r.weeksArchived > 0) {
    return `Archived ${weeksWord(r.weeksArchived)} · ${rowsWord(r.rowsArchived)} · ${formatBytes(r.bytes)}`;
  }
  return ARCHIVE_STATE_LABEL[sr.state];
}

/** "2 prune refusals" / "1 anomaly" — why this cell is amber. */
function archiveProblem(r: PublicArchiveRun): string {
  const bits: string[] = [];
  if (r.refusals > 0) bits.push(`${r.refusals} prune refusal${r.refusals === 1 ? "" : "s"}`);
  if (r.anomalies > 0) bits.push(`${r.anomalies} anomal${r.anomalies === 1 ? "y" : "ies"}`);
  return bits.join(" · ");
}

const ARCHIVE_DATA_LABEL: Record<ArchiveBodyState, string> = {
  archived: "Archived",
  pruned: "Pruned (verified at prune)",
};

/**
 * One archive tooltip, in two sections split by a rule — and the rule is the anti-ambiguity device,
 * not styling. Above it: what happened to the rows DATED this week. Below it: the archiver runs that
 * EXECUTED during this week, which are almost certainly about some other week's rows. A reader will
 * assume a clean mark beneath a pruned body means "that run pruned these rows" unless we stop them.
 *
 * Handles the empty cell too (no data, no runs), so both halves are always said, and "we have no
 * index for this week" never looks like "these rows are gone".
 */
function archiveTipHtml(r: number, table: string, cell: ArchiveCell | null): string {
  const name = esc(archiveLabel.get(table) ?? table);
  const lines = [`<div class="tip-when">Week of ${esc(grid.rows[r].weekStartLabel)} · ${name}</div>`];

  const data = cell?.data ?? null;
  lines.push(
    data
      ? `<div class="tip-state">${dot(bodyClass(data.state)!)}${ARCHIVE_DATA_LABEL[data.state]} · ${rowsWord(data.rows)}</div>`
      : `<div class="tip-muted">No rows archived for this week</div>`,
  );

  lines.push(`<hr class="tip-rule">`);

  const runs = cell?.runs ?? [];
  if (runs.length === 0) {
    lines.push(`<div class="tip-muted">No archiver run this week</div>`);
    return lines.join("");
  }
  lines.push(`<div class="tip-muted">Archiver runs this week · ${runs.length}</div>`);
  for (const sr of runs) {
    lines.push(`<div class="tip-state">${archiveDot(sr.state)}${esc(sr.whenLabel)} · ${archiveHeadline(sr)}</div>`);
  }
  if (runs.length === 1) {
    const sr = runs[0];
    if (sr.run.weeksPruned > 0) {
      lines.push(
        `<div class="tip-muted">Pruned ${weeksWord(sr.run.weeksPruned)} · ${rowsWord(sr.run.rowsPruned)} deleted from the database</div>`,
      );
    }
    if (sr.state === "attention") lines.push(`<div class="tip-fail">${archiveProblem(sr.run)} — needs a look</div>`);
    if (sr.state === "failed") lines.push(`<div class="tip-fail">Archive run failed.</div>`);
  } else {
    lines.push(actionsLine(runs.map(archiveCode)));
  }
  if (clickable(cell)) {
    lines.push(`<div class="tip-hint">${runs.length > 1 ? "Click to choose a run to open ↗" : "Click to open the GitHub run ↗"}</div>`);
  }
  return lines.join("");
}

function archiveChooserHtml(cell: ArchiveCell): string {
  const name = esc(archiveLabel.get(cell.table) ?? cell.table);
  const lines = [
    `<div class="tip-when">${name} — ${cell.runs.length} runs this week</div>`,
    `<div class="tip-muted">Open a run on GitHub:</div>`,
    ...cell.runs.map((sr) => linkRow(archiveDot(sr.state), `${esc(sr.whenLabel)} · ${ARCHIVE_STATE_LABEL[sr.state]}`, sr.run.runUrl)),
    `<div class="tip-hint">Esc or click away to dismiss</div>`,
  ];
  return lines.join("");
}

// Footer: generated-at
const footer = elem("footer", "footer", `Updated ${formatInTz(now)} · times in ${DISPLAY_TZ}`);
app.appendChild(footer);
