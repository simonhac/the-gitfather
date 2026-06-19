// ─────────────────────────────────────────────────────────────────────────────
// Browser entry for the backup-history dashboard. Reads the scrubbed PublicPayload
// from the inlined <script id="backup-data">, builds the GFS grid (shared logic),
// and renders an SVG heatmap + legend + summary into #app. Bundled into a single
// inline <script> by build-dashboard.ts (esbuild) — no runtime deps, no network.
// ─────────────────────────────────────────────────────────────────────────────

import { buildBackupGrid, summarize, formatInTz, slotApproxDate, WEEKDAY_LABELS } from "../scripts/lib/backupHistory.js";
import {
  SLOTS_PER_DAY,
  DAYS_PER_WEEK,
  COLS_PER_WEEK,
  DISPLAY_TZ,
  type PublicPayload,
  type BackupCellState,
  type BackupCell,
} from "../scripts/lib/backupTypes.js";

const SVGNS = "http://www.w3.org/2000/svg";
const CELL = 11;
const GAP = 2;
const PITCH = CELL + GAP;
const LEFT_AXIS = 62; // fits "DD MMM YY" in monospace
const TOP_AXIS = 20;
const WEEKS = 58;
const NOTCH = 3.5; // top-right corner bite that marks a multi-run slot
const CELL_STROKE = "rgba(0,0,0,0.08)";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const FILL: Record<Exclude<BackupCellState, "empty">, string> = {
  failed: "#e5484d",
  expired: "#b8bfc9",
  ok: "#1f8a54", // darker green — succeeded, still retained
  verified: "#34c878", // brighter green — restore-verified
};
const EMPTY_FILL = "#f1f3f5";
const GRID_BORDER = "#e4e7ec";
const MUTED = "#6b7280";

const TIER_LABEL: Record<string, string> = {
  "2hourly": "2-hourly", daily: "daily", weekly: "weekly", monthly: "monthly",
};
const STATE_LABEL: Record<BackupCellState, string> = {
  empty: "No backup", failed: "Failed", expired: "Expired (was OK)", ok: "Backup OK", verified: "Restore-verified",
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

const app = document.getElementById("app")!;

// ── Header ───────────────────────────────────────────────────────────────────
const header = elem("header", "header");
header.appendChild(elem("h1", undefined, `${payload.label} — backup history`));
header.appendChild(
  elem(
    "p",
    "subtitle",
    `Every 2-hourly off-site Postgres backup over the last ${WEEKS} weeks (400-day GFS window). Times in ${DISPLAY_TZ}. ` +
      `Grey is the GFS lifecycle at work — most slots age out after 2 days, leaving the daily/weekly/monthly anchors green for 21/70/400 days.`,
  ),
);
app.appendChild(header);

// ── Summary stats ────────────────────────────────────────────────────────────
const statsRow = elem("div", "stats");
const statDefs: [string, string | number][] = [
  ["Latest run", stats.latestLabel ?? "—"],
  ["Verified", stats.verified],
  ["Retained", stats.ok + stats.verified],
  ["Expired", stats.expired],
  ["Failed", stats.failed],
  ["Total runs", stats.total],
];
for (const [label, value] of statDefs) {
  const card = elem("div", "stat");
  card.appendChild(elem("div", "stat-label", label));
  card.appendChild(elem("div", "stat-value", String(value)));
  statsRow.appendChild(card);
}
app.appendChild(statsRow);

// ── Legend ───────────────────────────────────────────────────────────────────
const legend = elem("div", "legend");
const legendItems: [string, string, boolean][] = [
  ["Verified", FILL.verified, false],
  ["Backup OK", FILL.ok, false],
  ["Expired", FILL.expired, false],
  ["Failed", FILL.failed, false],
  ["No backup", EMPTY_FILL, true],
];
for (const [label, color, outline] of legendItems) {
  const item = elem("div", "legend-item");
  const sw = elem("span", "swatch");
  sw.style.background = color;
  if (outline) sw.style.border = `1px solid ${GRID_BORDER}`;
  item.appendChild(sw);
  item.appendChild(document.createTextNode(label));
  legend.appendChild(item);
}
app.appendChild(legend);

// ── Heatmap SVG ──────────────────────────────────────────────────────────────
const gridWidth = COLS_PER_WEEK * PITCH;
const gridHeight = grid.weeks * PITCH;
const totalWidth = LEFT_AXIS + gridWidth + 2;
const totalHeight = TOP_AXIS + gridHeight + 2;

const scroll = elem("div", "scroll");
const root = svg("svg", { width: totalWidth, height: totalHeight, class: "heatmap" }) as SVGSVGElement;

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

function drawCell(cell: BackupCell, x: number, y: number) {
  if (!cell.multiple) {
    root.appendChild(svg("rect", {
      x, y, width: CELL, height: CELL, rx: 2,
      fill: colorOf(cell.state), stroke: CELL_STROKE, "stroke-width": 0.5,
    }));
    return;
  }
  const successColor = cell.successState ? colorOf(cell.successState) : null;
  if (!cell.hasFailure || !successColor) {
    root.appendChild(svg("polygon", {
      points: notchedSquare(x, y),
      fill: successColor ?? FILL.failed, stroke: CELL_STROKE, "stroke-width": 0.5,
    }));
    return;
  }
  // mixed → split diagonally: top-right success, bottom-left red
  root.appendChild(svg("polygon", { points: successTriNotched(x, y), fill: successColor, stroke: CELL_STROKE, "stroke-width": 0.5 }));
  root.appendChild(svg("polygon", { points: failTri(x, y), fill: FILL.failed, stroke: CELL_STROKE, "stroke-width": 0.5 }));
}

grid.rows.forEach((row, r) => {
  for (const cell of row.cells.values()) {
    drawCell(cell, LEFT_AXIS + cell.col * PITCH + GAP / 2, TOP_AXIS + r * PITCH + GAP / 2);
  }
});

scroll.appendChild(root);
app.appendChild(scroll);

// ── Tooltip (single cursor-following element) ────────────────────────────────
const tip = elem("div", "tip");
tip.style.display = "none";
document.body.appendChild(tip);

let hoverCell: BackupCell | null = null;

root.addEventListener("mousemove", (e) => {
  const rect = root.getBoundingClientRect();
  const col = Math.floor((e.clientX - rect.left - LEFT_AXIS) / PITCH);
  const r = Math.floor((e.clientY - rect.top - TOP_AXIS) / PITCH);
  if (col < 0 || col >= COLS_PER_WEEK || r < 0 || r >= grid.weeks) {
    hide();
    return;
  }
  const cell = grid.rows[r]?.cells.get(col) ?? null;
  hoverCell = cell;
  tip.innerHTML = cell ? cellHtml(cell) : emptyHtml(r, col);
  root.style.cursor = latestUrl(cell) ? "pointer" : "default";
  const left = Math.min(e.clientX + 14, window.innerWidth - 260);
  tip.style.left = `${left}px`;
  tip.style.top = `${e.clientY + 14}px`;
  tip.style.display = "block";
});
root.addEventListener("mouseleave", hide);
root.addEventListener("click", () => {
  const url = latestUrl(hoverCell);
  if (url) window.open(url, "_blank", "noopener");
});

/** Run link of the latest run in a cell (cells are time-sorted), for click + cursor. */
function latestUrl(cell: BackupCell | null): string | null {
  return cell ? cell.runs[cell.runs.length - 1].run.runUrl : null;
}

function hide() {
  tip.style.display = "none";
  hoverCell = null;
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
    if (sr.verification?.ok) lines.push(`<div class="tip-muted">Drill restored &amp; verified${sr.verification.ratio != null ? ` (${(sr.verification.ratio * 100).toFixed(0)}% of live rows)` : ""}.</div>`);
    if (!sr.run.ok) lines.push(`<div class="tip-fail">Backup failed.</div>`);
  }
  if (latestUrl(cell)) lines.push(`<div class="tip-hint">Click to open the GitHub run ↗</div>`);
  return lines.join("");
}
function emptyHtml(r: number, col: number): string {
  const weekday = Math.floor(col / SLOTS_PER_DAY);
  const slot = col % SLOTS_PER_DAY;
  const label = formatInTz(slotApproxDate(grid.rows[r].weekStartOrdinal, weekday, slot));
  return `<div class="tip-when">${esc(label)}</div><div class="tip-muted">No backup at this slot</div>`;
}

// Footer: generated-at
const footer = elem("footer", "footer", `Updated ${formatInTz(now)}`);
app.appendChild(footer);
