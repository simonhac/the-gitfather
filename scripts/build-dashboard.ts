import "./lib/bootEnv.js"; // first — loads $PROFILE (no-op if unset) before DISPLAY_TZ is read/baked
// ─────────────────────────────────────────────────────────────────────────────
// Build the static backup-history dashboard (a single self-contained index.html).
//
//   tsx build-dashboard.ts [--sample] [--out PATH] [--upload]
//
//   --sample   use generated sample data instead of reading R2 (local preview)
//   --out      output path (default: ../dashboard/dist/index.html)
//   --upload   rclone-upload the result to the public dashboard bucket (r2dash remote)
//
// Reads the PRIVATE rich logs from R2 (_log/<name>/*.jsonl via the `r2`
// remote), maps them to the SCRUBBED PublicPayload (drops raw error text; keeps the
// project label + sizes per the privacy decision), esbuild-bundles dashboard/heatmap.ts,
// and inlines bundle + data into dashboard/template.html.
// ─────────────────────────────────────────────────────────────────────────────

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDashboardConfig, retentionFromConfig, joinObjectKey } from "./lib/config.js";
import { readLogDir, downloadLogsFromR2 } from "./lib/logStore.js";
import { shortTableName } from "./lib/archive.js";
import { HOURS_PER_SLOT, SLOT_MINUTES } from "./lib/backupTypes.js";
import type {
  LogRun,
  LogVerification,
  LogArchive,
  PublicPayload,
  PublicArchiveRun,
  PublicArchiveTable,
  BackupTier,
} from "./lib/backupTypes.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HEATMAP = join(SCRIPT_DIR, "../dashboard/heatmap.ts");
const TEMPLATE = join(SCRIPT_DIR, "../dashboard/template.html");

const argv = process.argv.slice(2);
const useSample = argv.includes("--sample");
const upload = argv.includes("--upload");
const outIdx = argv.indexOf("--out");
const outPath = outIdx >= 0 ? argv[outIdx + 1] : join(SCRIPT_DIR, "../dashboard/dist/index.html");
const logdirIdx = argv.indexOf("--logdir");
const logdir = logdirIdx >= 0 ? argv[logdirIdx + 1] : null; // read logs from a local dir instead of R2

// Validate + type config (zod). R2_BUCKET/name are required only when reading logs from R2
// (i.e. not --sample/--logdir); DASHBOARD_R2_BUCKET only with --upload — the schema enforces both.
const cfg = loadDashboardConfig({ fromR2: !useSample && !logdir, upload });
const label = cfg.dashboard.label ?? cfg.name ?? "database";
const hideLinks = cfg.dashboard.hideRunLinks;
const retention = retentionFromConfig(cfg.retention);

/** One archived table as the profile declares it — the fully-qualified name plus its windows. */
interface ArchiveSpec {
  table: string;
  archiveAfterWeeks: number;
  pruneAfterWeeks: number;
}

/** The profile's `archive.tables`, in profile order. Empty when the profile archives nothing. */
function profileArchiveSpecs(): ArchiveSpec[] {
  return cfg.archive.tables.map((t) => ({
    table: t.table,
    archiveAfterWeeks: t.archiveAfterWeeks,
    pruneAfterWeeks: t.pruneAfterWeeks,
  }));
}

/**
 * Fully-qualified table name → the name published to the dashboard. Normally the schema-stripped
 * short name (the schema is a detail of the profile's layout, not the dashboard's business); but
 * two tables in different schemas can share a short name — the config only rejects duplicate
 * FULLY-QUALIFIED names — and one column silently merging two tables would be a worse outcome than
 * one published schema name, so a collision leaves BOTH fully qualified.
 */
function publishedTableNames(fullNames: string[]): Map<string, string> {
  const claims = new Map<string, Set<string>>();
  for (const full of fullNames) {
    const short = shortTableName(full);
    const set = claims.get(short) ?? new Set<string>();
    set.add(full);
    claims.set(short, set);
  }
  return new Map(fullNames.map((full) => [full, claims.get(shortTableName(full))!.size > 1 ? full : shortTableName(full)]));
}

function scrub(
  runs: LogRun[],
  verifications: LogVerification[],
  archives: LogArchive[],
  archiveSpecs: ArchiveSpec[],
): PublicPayload {
  const payload: PublicPayload = {
    label,
    generatedAt: process.env.DASHBOARD_NOW || new Date().toISOString(),
    retention, // per-tier windows in effect (from the profile; defaults otherwise) — drives expiry + subtitle
    // Privacy: drop key + raw error text; keep label, sizes, tiers, run links (toggleable).
    runs: runs.map((r) => ({ t: r.ts, ok: r.ok, tiers: r.tiers, bytes: r.bytes, runUrl: hideLinks ? null : r.runUrl })),
    // kind drives the tooltip wording (restore vs byte-check); counts/reason/key/tier stay private.
    verifications: verifications.map((v) => ({ vt: v.verifiedTs, ok: v.ok, ratio: v.ratio, kind: v.kind })),
  };

  // Column order: the profile's tables first, then any table seen only in the log — a table dropped
  // from `archive.tables` keeps its column, because the rows it moved are still out there.
  const order = [...new Set([...archiveSpecs.map((t) => t.table), ...archives.map((a) => a.table)])];
  if (order.length === 0) return payload; // no archive block → a page identical to the pre-archive one

  const specByTable = new Map(archiveSpecs.map((t) => [t.table, t]));
  const nameOf = publishedTableNames(order);
  const tables: PublicArchiveTable[] = order.map((full) => ({
    table: nameOf.get(full)!,
    archiveAfterWeeks: specByTable.get(full)?.archiveAfterWeeks ?? null,
    pruneAfterWeeks: specByTable.get(full)?.pruneAfterWeeks ?? null,
  }));
  // Privacy: drop raw error text + runId + durationMs, and publish the short table name. Row counts
  // and bytes are kept, under the same decision that already publishes dump sizes.
  const archiveRuns: PublicArchiveRun[] = archives.map((a) => ({
    t: a.ts,
    ok: a.ok,
    table: nameOf.get(a.table)!,
    mode: a.mode,
    dryRun: a.dryRun,
    weeksArchived: a.weeksArchived,
    rowsArchived: a.rowsArchived,
    weeksPruned: a.weeksPruned,
    rowsPruned: a.rowsPruned,
    bytes: a.bytes,
    refusals: a.refusals,
    anomalies: a.anomalies,
    runUrl: hideLinks ? null : a.runUrl,
  }));
  return { ...payload, archive: { tables, runs: archiveRuns } };
}

function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

async function main(): Promise<void> {
  let runs: LogRun[];
  let verifications: LogVerification[];
  let archives: LogArchive[];
  // --sample has no profile to read windows from, so it carries its own; the real paths take theirs
  // from `archive.tables`.
  let archiveSpecs: ArchiveSpec[];
  if (useSample) {
    ({ runs, verifications, archives, archiveSpecs } = makeSample(new Date()));
  } else if (logdir) {
    ({ runs, verifications, archives } = readLogDir(logdir));
    archiveSpecs = profileArchiveSpecs();
  } else {
    if (!cfg.credentials.r2.bucket || !cfg.name) throw new Error("R2_BUCKET / profile name must be set to read logs from R2");
    ({ runs, verifications, archives } = downloadLogsFromR2(cfg.credentials.r2.bucket, cfg.name));
    archiveSpecs = profileArchiveSpecs();
  }
  const payload = scrub(runs, verifications, archives, archiveSpecs);
  const archiveNote = payload.archive
    ? `, ${payload.archive.runs.length} archive records over ${payload.archive.tables.length} table(s)`
    : "";
  console.log(
    `dashboard: ${payload.runs.length} runs, ${payload.verifications.length} verifications${archiveNote} (label="${label}")`,
  );

  const bundled = await build({
    entryPoints: [HEATMAP],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    write: false,
    legalComments: "none",
    // The browser bundle reads DISPLAY_TZ via `process.env.DISPLAY_TZ` (see backupTypes.ts); bake the
    // value in at build time so `process` is never referenced at runtime in the browser.
    define: {
      "process.env.DISPLAY_TZ": JSON.stringify(process.env.DISPLAY_TZ || "UTC"),
      // Same reason as DISPLAY_TZ: the bundle derives SLOTS_PER_DAY and the cadence prose from this
      // at module load, and a browser has no profile to read.
      "process.env.SLOT_MINUTES": JSON.stringify(String(SLOT_MINUTES)),
    },
  });
  const bundle = bundled.outputFiles[0].text;

  const dataJson = JSON.stringify(payload).replace(/</g, "\\u003c"); // safe inside <script type=application/json>
  const html = readFileSync(TEMPLATE, "utf8")
    .replace("__TITLE__", () => escHtml(`${label} — backup history`))
    .replace("__DATA__", () => dataJson)
    .replace("__BUNDLE__", () => bundle);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`dashboard: wrote ${outPath} (${(html.length / 1024).toFixed(0)} KB)`);

  if (upload) {
    const dbucket = cfg.credentials.dashboardR2.bucket; // schema-required with --upload; guard kept for the type
    if (!dbucket) throw new Error("DASHBOARD_R2_BUCKET must be set to --upload");
    // Object key under the (possibly shared) dashboard bucket: <path-prefix>/<name>/index.html.
    // joinObjectKey keeps it slash-clean so an empty prefix or stray slashes never yield "//".
    const objectKey = joinObjectKey(cfg.dashboard.pathPrefix, cfg.name ?? "", "index.html");
    execFileSync(
      "rclone",
      ["copyto", outPath, `r2dash:${dbucket}/${objectKey}`, "--s3-no-check-bucket", "--header-upload", "Content-Type: text/html; charset=utf-8"],
      { stdio: "inherit" },
    );
    console.log(`dashboard: uploaded → r2dash:${dbucket}/${objectKey}`);
  }
}

// ── Sample data (local preview only) ─────────────────────────────────────────
// A deterministic history that exercises the full GFS picture: an 8-hourly grandson run on
// every slot, promoted to daily/weekly/monthly on the 16:00-UTC anchors (so the heatmap shows
// the green lifespan "staircase"), an organically growing dump size, a sprinkle of isolated
// failures, and one believable outage. Spans a bit more than the 52-week grid so daily/weekly
// anchors visibly age to grey within the visible window.
const SAMPLE_DAYS = 380;
// The archive columns need their own sample: two tables on DIFFERENT windows (so the header
// sentence's harder "each on its own schedule" branch is the one you actually look at), starting
// part-way into the window so the empty band before archiving began is visible as a band rather
// than as a bug.
const SAMPLE_ARCHIVE_WEEKS = 30;
const SAMPLE_ARCHIVE_SPECS: ArchiveSpec[] = [
  { table: "public.api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 },
  { table: "public.audit_events", archiveAfterWeeks: 8, pruneAfterWeeks: 26 },
];
function makeSample(now: Date): {
  runs: LogRun[];
  verifications: LogVerification[];
  archives: LogArchive[];
  archiveSpecs: ArchiveSpec[];
} {
  let seed = 20260619;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const runs: LogRun[] = [];
  const verifications: LogVerification[] = [];
  const end = now.getTime();
  const start = end - SAMPLE_DAYS * 86_400_000;
  const slotMs = HOURS_PER_SLOT * 3_600_000;
  const first = Math.ceil(start / slotMs) * slotMs;

  // Dump size grows toward the present: a mid-size production DB ~2.2 GB at the window
  // start, compounding ~0.2%/day to ~4.9 GB now, with a steady per-day wobble and a
  // little intraday jitter (so the GB-stored / R2-cost figures are representative).
  const BASE_BYTES = 2_200_000_000;
  const DAILY_GROWTH = 0.002;
  // Each run links to its own GitHub Actions run (distinct per run, like the real logs).
  const ghRun = (ms: number) => `https://github.com/owner/repo/actions/runs/${16_000_000_000 + Math.floor(ms / 60_000)}`;

  // One contiguous outage: a ~10-hour DB-connectivity failure centred ~5 days ago.
  const outageStart = end - 5.4 * 86_400_000;
  const outageEnd = end - 5.0 * 86_400_000;

  for (let t = first; t <= end; t += slotMs) {
    const d = new Date(t);
    const ts = d.toISOString().replace(".000", "");
    const daysSinceStart = (t - start) / 86_400_000;

    const inOutage = t >= outageStart && t <= outageEnd;
    // ~0.6% isolated failures the rest of the time (transient hiccups, locks, …).
    const failed = inOutage || rand() < 0.006;
    if (failed) {
      const error = inOutage
        ? "pg_dump: could not connect to server: Connection refused"
        : "pg_dump: server closed the connection unexpectedly";
      runs.push({ ts, ok: false, tiers: [], bytes: null, key: null, sha256: null, counts: null, runId: null, runUrl: ghRun(t), error, errorCode: null, durationMs: 26_000 });
      continue;
    }

    const tiers: BackupTier[] = ["2hourly"];
    if (d.getUTCHours() === 16) {
      tiers.push("daily");
      if (d.getUTCDay() === 0) tiers.push("weekly");
      if (d.getUTCDate() === 1) tiers.push("monthly");
    }

    const trend = BASE_BYTES * Math.pow(1 + DAILY_GROWTH, daysSinceStart);
    const dayWobble = 1 + 0.025 * Math.sin(daysSinceStart / 6); // slow ±2.5% drift
    const jitter = 1 + (rand() - 0.5) * 0.02; // ±1% intraday
    const bytes = Math.round(trend * dayWobble * jitter);

    runs.push({ ts, ok: true, tiers, bytes, key: null, sha256: null, counts: null, runId: null, runUrl: ghRun(t), error: null, errorCode: null, durationMs: 92_000 });
  }

  // A couple of slots with more than one run, to exercise the multi-run rendering: when two runs
  // land in the same display slot (a manual rerun, or a failure that's retried), the cell's mark
  // splits into two dashes if they disagreed. Placed in the last ~2 days so the 2hourly copies are
  // still retained (green), not aged-out grey.
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000", "");
  const bucket = (hoursAgo: number) => Math.floor((end - hoursAgo * 3_600_000) / slotMs) * slotMs;

  // (a) Mixed slot: the scheduled run (already added by the loop, OK) plus a manual rerun ~40 min
  //     later that failed → a green body with a two-dash mark (red + muted).
  const mixed = bucket(20) + 40 * 60_000;
  runs.push({ ts: iso(mixed), ok: false, tiers: [], bytes: null, key: null, sha256: null, counts: null, runId: null, runUrl: ghRun(mixed), error: "pg_dump: canceled statement due to lock_timeout", errorCode: null, durationMs: 31_000 });

  // (b) Multi-success slot: the scheduled run plus a successful manual rerun ~50 min later. Both
  //     clean, so under the grammar the cell stays a plain green body — the count is in the tooltip.
  const rerun = bucket(40) + 50 * 60_000;
  runs.push({ ts: iso(rerun), ok: true, tiers: ["2hourly"], bytes: 4_840_000_000, key: null, sha256: null, counts: null, runId: null, runUrl: ghRun(rerun), error: null, errorCode: null, durationMs: 88_000 });

  // One restore drill per weekly anchor (Sunday daily backup), run ~30 h later. ~97% pass.
  const weekly = runs.filter((r) => r.ok && r.tiers.includes("weekly")).map((r) => r.ts);
  for (const verifiedTs of weekly) {
    const drillRan = new Date(Date.parse(verifiedTs) + 30 * 3_600_000);
    if (drillRan.getTime() > end) continue;
    verifications.push({ ts: drillRan.toISOString().replace(".000", ""), verifiedTs, ok: rand() < 0.97, ratio: 0.97 + rand() * 0.03, runId: null, runUrl: null });
  }

  // ── Archive history ────────────────────────────────────────────────────────
  // The archive runs weekly at Sunday 19:30 UTC — 3.5 h after the 16:00 UTC anchor that becomes the
  // weekly backup — so in any display timezone the two land in the same week row. That alignment is
  // the whole point of the sibling columns, so the sample must reproduce it exactly.
  const archives: LogArchive[] = [];
  const lastArchive = (() => {
    const d = new Date(end);
    d.setUTCHours(19, 30, 0, 0);
    while (d.getUTCDay() !== 0 || d.getTime() > end) d.setUTCDate(d.getUTCDate() - 1);
    return d.getTime();
  })();
  const archiveRecord = (t: number, table: string, over: Partial<LogArchive> = {}): LogArchive => ({
    ts: iso(t), ok: true, table, mode: "both", dryRun: "none",
    weeksArchived: 1, rowsArchived: 0, weeksPruned: 0, rowsPruned: 0,
    bytes: 0, refusals: 0, anomalies: 0, error: null, durationMs: 41_000, runId: null, runUrl: ghRun(t),
    ...over,
  });
  // Per-table weekly volume: a chatty log table and a much smaller audit trail.
  const VOLUME: Record<string, { rows: number; spread: number; bytesPerRow: number }> = {
    "public.api_logs": { rows: 45_000, spread: 10_000, bytesPerRow: 64 },
    "public.audit_events": { rows: 8_000, spread: 4_000, bytesPerRow: 88 },
  };

  for (let w = 0; w < SAMPLE_ARCHIVE_WEEKS; w++) {
    const t = lastArchive - w * 7 * 86_400_000;
    // The whole run failed this week — every table's record is marked not-ok, as archive-table.ts
    // does (one `failure` stamps all of them).
    const runFailed = w === 10;
    for (const spec of SAMPLE_ARCHIVE_SPECS) {
      const v = VOLUME[spec.table];
      const rows = Math.round(v.rows + rand() * v.spread);
      if (runFailed) {
        archives.push(archiveRecord(t, spec.table, {
          ok: false, weeksArchived: 0, weeksPruned: 0, bytes: 0, durationMs: 12_000,
          error: "archive: could not acquire the store lock",
        }));
        continue;
      }
      // Nothing was eligible this week — it ran, the database did not change.
      if (w === 3) {
        archives.push(archiveRecord(t, spec.table, { weeksArchived: 0, bytes: 0, durationMs: 9_000 }));
        continue;
      }
      // The fingerprint gate declined to delete: not a breakage, but somebody must look.
      const refusing = w === 6 && spec.table === "public.api_logs";
      // Pruning only starts once the first archived weeks have aged past prune-after-weeks.
      const pruning = w <= SAMPLE_ARCHIVE_WEEKS - 10;
      archives.push(archiveRecord(t, spec.table, {
        ok: !refusing,
        rowsArchived: rows,
        bytes: rows * v.bytesPerRow,
        weeksPruned: pruning && !refusing ? 1 : 0,
        rowsPruned: pruning && !refusing ? Math.round(v.rows + rand() * v.spread) : 0,
        refusals: refusing ? 2 : 0,
        error: refusing ? "prune refused: live fingerprint does not match the manifest" : null,
      }));
    }
    // A manual backfill alongside the scheduled run — exercises the multi-run chooser in a column.
    if (w === 14) {
      const backfill = t + 3 * 3_600_000;
      const v = VOLUME["public.api_logs"];
      const rows = Math.round(v.rows * 3 + rand() * v.spread);
      archives.push(archiveRecord(backfill, "public.api_logs", {
        mode: "archive", weeksArchived: 3, rowsArchived: rows, bytes: rows * v.bytesPerRow, durationMs: 156_000,
      }));
    }
  }

  return { runs, verifications, archives, archiveSpecs: SAMPLE_ARCHIVE_SPECS };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
