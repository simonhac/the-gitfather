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
  type ArchiveCell,
  type ArchiveSlotRun,
} from "../scripts/lib/backupTypes.js";

const SVGNS = "http://www.w3.org/2000/svg";
const CELL = 11;
const GAP = 2;
const PITCH = CELL + GAP;
const LEFT_AXIS = 62; // fits "DD MMM YY" in monospace
const TOP_AXIS = 20;
const WEEKS = 52;
const NOTCH = 3.5; // top-right corner bite that marks a multi-run slot
const ARCHIVE_GUTTER = 10; // breathing room between the backup grid and the archive block
// Wider than the grid's PITCH: an archive column carries a "T1" header, and at the grid pitch two
// of those headers touch. Only the ROW pitch has to match the grid — the columns are free.
const ARCHIVE_PITCH = CELL + 6;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const DARK = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

const FILL: Record<Exclude<BackupCellState, "empty">, string> = {
  failed: "#e5484d",
  expired: DARK ? "#3a414e" : "#cdd3dc", // aged-out slot — recedes into the grid
  ok: DARK ? "#2a9d63" : "#1f8a54", // succeeded, still retained
  verified: DARK ? "#41d586" : "#2fb872", // brighter green — restore-verified
  unverified: DARK ? "#e0a23a" : "#d9911f", // amber — backup OK but a restore/hash drill FAILED (≠ red failed backup)
};
const EMPTY_FILL = DARK ? "#20242d" : "#eef0f4";
const GRID_BORDER = DARK ? "#2a2f3a" : "#e3e6ec";
const MUTED = DARK ? "#949cad" : "#677085";
const CELL_STROKE = DARK ? "rgba(255,255,255,0.06)" : "rgba(16,24,40,0.08)";

// The `2hourly` key is the frozen R2 prefix, not the cadence — label it from the profile's slot
// width so a tooltip cannot say "2-hourly" about an 8-hourly backup.
const TIER_LABEL: Record<string, string> = {
  "2hourly": slotCadenceAdjective(), daily: "daily", weekly: "weekly", monthly: "monthly",
};
const STATE_LABEL: Record<BackupCellState, string> = {
  empty: "No backup", failed: "Failed", expired: "Expired (was OK)", ok: "Backup OK",
  verified: "Restore-verified", unverified: "Drill failed",
};

// An archive is not a backup — it is where rows LIVE once they have left Postgres, and it never
// expires — so it gets a hue of its own rather than a shade of the backup greens. Amber and red keep
// the meanings they already have on this page, so the legend gains no duplicate entries.
const ARCHIVE_FILL: Record<ArchiveCellState, string> = {
  archived: DARK ? "#5b9cf0" : "#3b7dd8",
  quiet: EMPTY_FILL, // hollow — the archive hue is the outline, see drawArchiveCell
  attention: FILL.unverified,
  failed: FILL.failed,
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
const header = elem("header", "header");
header.appendChild(elem("h1", undefined, `${payload.label} — backup history`));
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
header.appendChild(intro);
header.appendChild(elem("p", "subtitle", "Older copies thin out on a Grandfather–Father–Son schedule:"));
const ladder = elem("ul", "tiers");
for (const bullet of retentionBullets(R)) ladder.appendChild(elem("li", undefined, bullet));
header.appendChild(ladder);
header.appendChild(elem("p", "subtitle", `…at its fullest about ${maxRetained(R)} backups at once.`));
if (archiveCols && payload.archive) {
  const { lead, emphasis, tail } = archiveBlurb(payload.archive.tables);
  const blurb = elem("p", "subtitle");
  blurb.append(lead, elem("em", undefined, emphasis), tail);
  header.appendChild(blurb);
}
header.appendChild(
  elem(
    "p",
    "subtitle",
    `Greens are retained (brighter = restore-verified), amber flags a failed verification drill, ` +
      `grey has aged out. Times per ${DISPLAY_TZ}.`,
  ),
);
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
    { label: "Rows archived", value: archiveStats.rowsArchived.toLocaleString("en-GB"), hint: `Rows written to archive objects over the last ${WEEKS} weeks.` },
    { label: "Rows pruned", value: archiveStats.rowsPruned.toLocaleString("en-GB"), hint: `Rows deleted from the database after archiving, over the last ${WEEKS} weeks.` },
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
const legend = elem("div", "legend");
const MIXED_SWATCH = `linear-gradient(to top right, ${FILL.failed} 0 50%, ${FILL.ok} 50% 100%)`;
/** One legend entry. `border` is the outline colour for a hollow swatch (null = filled). */
function addLegendItem(label: string, background: string, border: string | null): void {
  const item = elem("div", "legend-item");
  const sw = elem("span", "swatch");
  sw.style.background = background;
  if (border) sw.style.border = `1px solid ${border}`;
  item.appendChild(sw);
  item.appendChild(document.createTextNode(label));
  legend.appendChild(item);
}
const legendItems: [string, string, string | null][] = [
  ["Verified", FILL.verified, null],
  ["Backup OK", FILL.ok, null],
  ["Drill failed", FILL.unverified, null],
  ["Mixed (ok + failed)", MIXED_SWATCH, null],
  ["Expired", FILL.expired, null],
  ["Failed", FILL.failed, null],
  ["No backup", EMPTY_FILL, GRID_BORDER],
];
for (const [label, color, border] of legendItems) addLegendItem(label, color, border);
// The archive keys sit past a divider: red, amber and empty already mean the same thing on both
// sides of it, so only the two archive-specific swatches and the column key are added.
if (archiveCols) {
  legend.appendChild(elem("span", "legend-sep"));
  addLegendItem("Archived", ARCHIVE_FILL.archived, null);
  addLegendItem("Nothing to archive", EMPTY_FILL, ARCHIVE_FILL.archived);
  for (const table of archiveCols.tables) legend.appendChild(elem("div", "legend-item", archiveLabel.get(table)!));
}
card.appendChild(legend);

// ── Heatmap SVG ──────────────────────────────────────────────────────────────
const gridWidth = COLS_PER_WEEK * PITCH;
const gridHeight = grid.weeks * PITCH;
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

// Weekday headers
WEEKDAY_LABELS.forEach((label, day) => {
  const t = svg("text", {
    x: LEFT_AXIS + (day * SLOTS_PER_DAY + SLOTS_PER_DAY / 2) * PITCH,
    y: TOP_AXIS - 8, "text-anchor": "middle", fill: MUTED, "font-size": 10, "font-family": MONO,
  });
  t.textContent = label;
  root.appendChild(t);
});

// Week-start row labels
grid.rows.forEach((row, r) => {
  const t = svg("text", {
    x: LEFT_AXIS - 8, y: TOP_AXIS + r * PITCH + CELL - 1, "text-anchor": "end", fill: MUTED, "font-size": 9, "font-family": MONO,
  });
  t.textContent = row.weekStartLabel;
  root.appendChild(t);
});

// Backdrop + day-delineation lines
root.appendChild(svg("rect", {
  x: LEFT_AXIS, y: TOP_AXIS, width: gridWidth, height: gridHeight, fill: EMPTY_FILL, stroke: GRID_BORDER, "stroke-width": 1, rx: 3,
}));
for (let i = 1; i < DAYS_PER_WEEK; i++) {
  const x = LEFT_AXIS + i * SLOTS_PER_DAY * PITCH - GAP / 2;
  root.appendChild(svg("line", { x1: x, y1: TOP_AXIS, x2: x, y2: TOP_AXIS + gridHeight, stroke: GRID_BORDER, "stroke-width": 1 }));
}

// Archive backdrop + T1…Tn column headers (same style and baseline as Mon…Sun).
if (archiveCols) {
  root.appendChild(svg("rect", {
    x: archiveX0, y: TOP_AXIS, width: archiveWidth, height: gridHeight,
    fill: EMPTY_FILL, stroke: GRID_BORDER, "stroke-width": 1, rx: 3,
  }));
  archiveCols.tables.forEach((_table, i) => {
    const t = svg("text", {
      x: archiveX0 + (i + 0.5) * ARCHIVE_PITCH, y: TOP_AXIS - 8,
      "text-anchor": "middle", fill: MUTED, "font-size": 10, "font-family": MONO,
    });
    t.textContent = `T${i + 1}`;
    root.appendChild(t);
  });
}

// Where a cell sits, in viewBox user units. The draw loops and the hover anchor both go through
// these, so the beak can never point somewhere the cell isn't.
const backupCellX = (col: number): number => LEFT_AXIS + col * PITCH + GAP / 2;
const archiveCellX = (i: number): number => archiveX0 + i * ARCHIVE_PITCH + (ARCHIVE_PITCH - CELL) / 2;
const cellY = (r: number): number => TOP_AXIS + r * PITCH + GAP / 2;

// Cells (only non-empty slots are drawn).
//   single run        → rounded square
//   multi, all same   → square with a top-right notch (the notch = "more than one run here")
//   multi, mixed      → diagonal split: top-right = best success, bottom-left = red, notched
function colorOf(state: BackupCellState): string {
  return FILL[state as Exclude<BackupCellState, "empty">];
}
const notchedSquare = (x: number, y: number) =>
  `${x},${y} ${x + CELL - NOTCH},${y} ${x + CELL},${y + NOTCH} ${x + CELL},${y + CELL} ${x},${y + CELL}`;
const successTriNotched = (x: number, y: number) =>
  `${x},${y} ${x + CELL - NOTCH},${y} ${x + CELL},${y + NOTCH} ${x + CELL},${y + CELL}`;
const failTri = (x: number, y: number) => `${x},${y} ${x + CELL},${y + CELL} ${x},${y + CELL}`;

/**
 * The one cell shape, shared by both grids: a rounded square, a notched square when the slot holds
 * more than one run, and a diagonal split when those runs disagree. Only the colours differ between
 * a backup cell and an archive cell, so the notch/split geometry lives here once.
 *
 * `stroke` overrides the hairline outline — it is how a hollow cell gets its coloured border.
 */
function drawShape(
  x: number,
  y: number,
  o: { fill: string; stroke?: string; notched: boolean; splitFill?: string | null },
): void {
  const outline = o.stroke ?? CELL_STROKE;
  const sw = o.stroke ? 1 : 0.5;
  if (!o.notched) {
    root.appendChild(svg("rect", { x, y, width: CELL, height: CELL, rx: 2, fill: o.fill, stroke: outline, "stroke-width": sw }));
    return;
  }
  if (!o.splitFill) {
    root.appendChild(svg("polygon", { points: notchedSquare(x, y), fill: o.fill, stroke: outline, "stroke-width": sw }));
    return;
  }
  // mixed → split diagonally: top-right the good outcome, bottom-left the bad one
  root.appendChild(svg("polygon", { points: successTriNotched(x, y), fill: o.fill, stroke: outline, "stroke-width": sw }));
  root.appendChild(svg("polygon", { points: failTri(x, y), fill: o.splitFill, stroke: outline, "stroke-width": sw }));
}

function drawCell(cell: BackupCell, x: number, y: number) {
  const successColor = cell.successState ? colorOf(cell.successState) : null;
  drawShape(x, y, {
    fill: cell.multiple && !successColor ? FILL.failed : colorOf(cell.state),
    notched: cell.multiple,
    splitFill: cell.multiple && cell.hasFailure && successColor ? FILL.failed : null,
  });
}

function drawArchiveCell(cell: ArchiveCell, x: number, y: number) {
  // A quiet week is hollow: it must be distinguishable from a week with no run at all (which draws
  // nothing and lets the backdrop show), without reading as work that happened.
  const hollow = cell.state === "quiet";
  drawShape(x, y, {
    fill: ARCHIVE_FILL[cell.state],
    stroke: hollow ? ARCHIVE_FILL.archived : undefined,
    notched: cell.multiple,
    splitFill: cell.multiple && cell.problemState && cell.successState ? ARCHIVE_FILL[cell.problemState] : null,
  });
}

grid.rows.forEach((row, r) => {
  for (const cell of row.cells.values()) drawCell(cell, backupCellX(cell.col), cellY(r));
});

archiveCols?.rows.forEach((cells, r) => {
  for (const cell of cells.values()) {
    const i = archiveIndex.get(cell.table);
    // Cells stay CELL-sized and centred in the wider archive column; only the row pitch is shared.
    if (i != null) drawArchiveCell(cell, archiveCellX(i), cellY(r));
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
  const r = Math.floor(((e.clientY - rect.top) / scale - TOP_AXIS) / PITCH);
  if (r < 0 || r >= grid.weeks) {
    hide();
    return;
  }
  // The cell's own box, in client px — the panel and its beak hang off this, not off the pointer.
  const anchorAt = (cellUx: number): Anchor => ({
    cx: rect.left + (cellUx + CELL / 2) * scale,
    top: rect.top + cellY(r) * scale,
    bottom: rect.top + (cellY(r) + CELL) * scale,
  });

  const col = Math.floor((ux - LEFT_AXIS) / PITCH);
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
    html = cell ? archiveCellHtml(cell) : archiveEmptyHtml(r, table);
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
/** Run link of the latest run in a cell (cells are time-sorted), for the single-run click. */
function latestUrl(cell: Linked | null): string | null {
  return cell ? cell.runs[cell.runs.length - 1].run.runUrl : null;
}
/** A cell is clickable if any of its runs has a GitHub run link. */
function clickable(cell: Linked | null): boolean {
  return !!cell && cell.runs.some((sr) => sr.run.runUrl != null);
}

function hide() {
  tip.style.display = "none";
  hover = null;
}

function dot(state: BackupCellState): string {
  const c = state === "empty" ? "#cbd2da" : FILL[state as Exclude<BackupCellState, "empty">];
  return `<span class="dot" style="background:${c}"></span>`;
}
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

function cellHtml(cell: BackupCell): string {
  const lines: string[] = [];
  if (cell.multiple) {
    // Multiple runs in one slot — list each so nothing is hidden by the headline colour.
    const mixed = cell.hasFailure && cell.successState;
    lines.push(`<div class="tip-when">${cell.runs.length} runs this slot${mixed ? " — mixed" : ""}</div>`);
    for (const sr of cell.runs) {
      const size = sr.run.bytes != null ? ` · ${formatBytes(sr.run.bytes)}` : "";
      lines.push(`<div class="tip-state">${dot(sr.state)}${esc(sr.whenLabel)} · ${STATE_LABEL[sr.state]}${size}</div>`);
    }
  } else {
    const sr = cell.runs[0];
    lines.push(`<div class="tip-when">${esc(sr.whenLabel)}</div>`);
    lines.push(`<div class="tip-state">${dot(sr.state)}${STATE_LABEL[sr.state]}</div>`);
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
  if (clickable(cell)) {
    lines.push(`<div class="tip-hint">${cell.multiple ? "Click to choose a run to open ↗" : "Click to open the GitHub run ↗"}</div>`);
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
  return linkRow(dot(sr.state), `${esc(sr.whenLabel)} · ${STATE_LABEL[sr.state]}${size}`, sr.run.runUrl);
}
function chooserHtml(cell: BackupCell): string {
  const mixed = cell.hasFailure && cell.successState;
  const lines = [
    `<div class="tip-when">${cell.runs.length} runs this slot${mixed ? " — mixed" : ""}</div>`,
    `<div class="tip-muted">Open a run on GitHub:</div>`,
    ...cell.runs.map(runLink),
    `<div class="tip-hint">Esc or click away to dismiss</div>`,
  ];
  return lines.join("");
}

// ── Archive tooltips ─────────────────────────────────────────────────────────

const weeksWord = (n: number): string => `${n} week${n === 1 ? "" : "s"}`;
const rowsWord = (n: number): string => `${n.toLocaleString("en-GB")} row${n === 1 ? "" : "s"}`;

function archiveDot(state: ArchiveCellState): string {
  // The hollow state has to survive as a 9px dot too, or the tooltip contradicts the cell.
  const border = state === "quiet" ? `;border:1px solid ${ARCHIVE_FILL.archived};box-sizing:border-box` : "";
  return `<span class="dot" style="background:${ARCHIVE_FILL[state]}${border}"></span>`;
}

/** What this run actually did, in one line. */
function archiveHeadline(sr: ArchiveSlotRun): string {
  const r = sr.run;
  if (sr.state === "quiet") {
    return r.dryRun !== "none" ? `Dry run (${r.dryRun})` : "Ran — nothing eligible this week";
  }
  if (r.weeksArchived > 0) {
    return `Archived · ${weeksWord(r.weeksArchived)} · ${rowsWord(r.rowsArchived)} · ${formatBytes(r.bytes)}`;
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

function archiveCellHtml(cell: ArchiveCell): string {
  const name = esc(archiveLabel.get(cell.table) ?? cell.table);
  const lines: string[] = [];
  if (cell.multiple) {
    lines.push(`<div class="tip-when">${name} — ${cell.runs.length} runs this week</div>`);
    for (const sr of cell.runs) {
      lines.push(`<div class="tip-state">${archiveDot(sr.state)}${esc(sr.whenLabel)} · ${archiveHeadline(sr)}</div>`);
    }
  } else {
    const sr = cell.runs[0];
    lines.push(`<div class="tip-when">${esc(sr.whenLabel)} · ${name}</div>`);
    lines.push(`<div class="tip-state">${archiveDot(sr.state)}${archiveHeadline(sr)}</div>`);
    if (sr.run.weeksPruned > 0) {
      lines.push(
        `<div class="tip-muted">Pruned ${weeksWord(sr.run.weeksPruned)} · ${rowsWord(sr.run.rowsPruned)} deleted from the database</div>`,
      );
    }
    if (sr.state === "attention") lines.push(`<div class="tip-fail">${archiveProblem(sr.run)} — needs a look</div>`);
    if (sr.state === "failed") lines.push(`<div class="tip-fail">Archive run failed.</div>`);
  }
  if (clickable(cell)) {
    lines.push(`<div class="tip-hint">${cell.multiple ? "Click to choose a run to open ↗" : "Click to open the GitHub run ↗"}</div>`);
  }
  return lines.join("");
}

function archiveEmptyHtml(r: number, table: string): string {
  const name = esc(archiveLabel.get(table) ?? table);
  return (
    `<div class="tip-when">Week of ${esc(grid.rows[r].weekStartLabel)} · ${name}</div>` +
    `<div class="tip-muted">No archive run this week</div>`
  );
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
const footer = elem("footer", "footer", `Updated ${formatInTz(now)}`);
app.appendChild(footer);
