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
import { downloadArchiveIndexFromR2, readArchiveIndexDir, scrubArchiveWeek } from "./lib/archiveIndex.js";
import {
  shortTableName,
  eligibleWeeks,
  isWeekEligible,
  parseWeekLabel,
  WEEK_MS,
  type ArchivedPart,
  type WeekState,
} from "./lib/archive.js";
import { HOURS_PER_SLOT, SLOT_MINUTES } from "./lib/backupTypes.js";
import type {
  LogRun,
  LogVerification,
  LogArchive,
  PublicPayload,
  PublicArchiveRun,
  PublicArchiveTable,
  PublicArchiveWeek,
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

/**
 * Column order: the profile's tables first, then any table seen only in the log — a table dropped
 * from `archive.tables` keeps its column, because the rows it moved are still out there. Fully
 * qualified, as the profile and the run-log spell them.
 */
function archiveTableOrder(archives: LogArchive[], archiveSpecs: ArchiveSpec[]): string[] {
  return [...new Set([...archiveSpecs.map((t) => t.table), ...archives.map((a) => a.table)])];
}

/**
 * The SHORT names to fetch `_index/` under — that is the form the archiver writes its object keys
 * in. Two tables in different schemas sharing a short name already share one `_index/` path in R2
 * (an archiver-level problem, not a dashboard one), so both are skipped with a warning rather than
 * one table being shown another's weeks.
 */
function archiveIndexTables(order: string[]): string[] {
  const claims = new Map<string, string[]>();
  for (const full of order) {
    const short = shortTableName(full);
    claims.set(short, [...(claims.get(short) ?? []), full]);
  }
  const out: string[] = [];
  for (const [short, fulls] of claims) {
    if (fulls.length > 1) {
      console.warn(`dashboard: WARNING ${fulls.join(" and ")} share the _index/ path "${short}" — skipping their week states`);
      continue;
    }
    out.push(short);
  }
  return out;
}

function scrub(
  runs: LogRun[],
  verifications: LogVerification[],
  archives: LogArchive[],
  archiveSpecs: ArchiveSpec[],
  archiveWeeks: PublicArchiveWeek[] | null,
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

  const order = archiveTableOrder(archives, archiveSpecs);
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
  // `weeks` is omitted entirely when the index was not read, so the browser can tell "we did not
  // look" from "we looked and there is nothing there".
  const published = new Set(tables.map((t) => t.table));
  return {
    ...payload,
    archive: {
      tables,
      runs: archiveRuns,
      ...(archiveWeeks ? { weeks: archiveWeeks.filter((w) => published.has(w.table)) } : {}),
    },
  };
}

/**
 * The `_index/` view of what happened to each week's ROWS — the archive cells' body channel.
 *
 * null means "not read this build", which the payload keeps distinct from "read and empty". The
 * whole call is wrapped: this is a second, later-added source, and a dashboard that fails to build
 * because an index could not be listed would be a worse outcome than one drawn from runs alone.
 * --sample carries its own weeks, so it never comes through here.
 */
function readArchiveIndex(archives: LogArchive[], archiveSpecs: ArchiveSpec[]): PublicArchiveWeek[] | null {
  if (useSample) return null; // the sample carries its own weeks
  const tables = archiveIndexTables(archiveTableOrder(archives, archiveSpecs));
  if (tables.length === 0) return null;
  const prefix = cfg.archive.storePrefix;
  try {
    if (logdir) return readArchiveIndexDir(logdir, tables);
    if (!prefix) return null; // nothing archives here, so there is no store to read
    if (!cfg.credentials.r2.bucket) return null;
    return downloadArchiveIndexFromR2(cfg.credentials.r2.bucket, prefix, tables);
  } catch (e) {
    console.warn(`dashboard: WARNING could not read the archive index (${(e as Error).message}) — runs only`);
    return null;
  }
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
  // The sample builds its own index alongside its own runs, from one simulation — so a preview can
  // never show a body and a run history that contradict each other.
  let sampleIndex: SampleIndexRecord[] = [];
  if (useSample) {
    ({ runs, verifications, archives, archiveSpecs, index: sampleIndex } = makeSample(new Date()));
  } else if (logdir) {
    ({ runs, verifications, archives } = readLogDir(logdir));
    archiveSpecs = profileArchiveSpecs();
  } else {
    if (!cfg.credentials.r2.bucket || !cfg.name) throw new Error("R2_BUCKET / profile name must be set to read logs from R2");
    ({ runs, verifications, archives } = downloadLogsFromR2(cfg.credentials.r2.bucket, cfg.name));
    archiveSpecs = profileArchiveSpecs();
  }
  // The sample's records go through the same scrub as R2's, so the preview exercises the privacy
  // boundary rather than stepping around it.
  const archiveWeeks = useSample
    ? sampleIndex
        .map(({ table, record }) => scrubArchiveWeek(table, record))
        .filter((w): w is PublicArchiveWeek => w != null)
    : readArchiveIndex(archives, archiveSpecs);
  const payload = scrub(runs, verifications, archives, archiveSpecs, archiveWeeks);
  const archiveNote = payload.archive
    ? `, ${payload.archive.runs.length} archive records over ${payload.archive.tables.length} table(s)` +
      (payload.archive.weeks ? `, ${payload.archive.weeks.length} indexed week(s)` : ", no _index/ read")
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
/** Weeks of history already in the tables when archiving started — the backlog to work off. */
const SAMPLE_BACKLOG_WEEKS = 26;
/** A run's `max-weeks-per-run` and its pruning equivalent: enough to catch up, not in one go. */
const SAMPLE_MAX_WEEKS_PER_RUN = 2;
const SAMPLE_MAX_PRUNES_PER_RUN = 2;

/** One private index line as archive-table.ts would have written it, and the table it belongs to. */
interface SampleIndexRecord {
  table: string;
  record: WeekState & { updatedAt: string };
}

function makeSample(now: Date): {
  runs: LogRun[];
  verifications: LogVerification[];
  archives: LogArchive[];
  archiveSpecs: ArchiveSpec[];
  index: SampleIndexRecord[];
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
  // Pin ONE failed drill, on a copy still inside its retention window. At 97% the preview usually
  // has none, and "a backup we hold whose restore did not verify" — a green body under an amber
  // bar — is the case the two-channel grammar exists to be able to say.
  const pinned = verifications[verifications.length - 2];
  if (pinned) {
    pinned.ok = false;
    pinned.ratio = 0.41;
  }

  // ── Archive history ────────────────────────────────────────────────────────
  // Simulated rather than hand-set, because the two channels a cell now draws come from two
  // sources: if the run records and the index were written independently, the preview could show a
  // pruned week that no run ever pruned. So one state machine per table emits both — the runs are
  // what it DID, and the index is where it ENDED UP.
  //
  // The archiver runs weekly at Sunday 19:30 UTC — 3.5 h after the 16:00 UTC anchor that becomes
  // the weekly backup — so in any display timezone the two land in the same week row. That
  // alignment is the whole point of the sibling columns, so the sample reproduces it exactly.
  const archives: LogArchive[] = [];
  const index: SampleIndexRecord[] = [];
  const lastArchive = (() => {
    const d = new Date(end);
    d.setUTCHours(19, 30, 0, 0);
    while (d.getUTCDay() !== 0 || d.getTime() > end) d.setUTCDate(d.getUTCDate() - 1);
    return d.getTime();
  })();
  const archiveRecord = (t: number, table: string, over: Partial<LogArchive> = {}): LogArchive => ({
    ts: iso(t), ok: true, table, mode: "both", dryRun: "none",
    weeksArchived: 0, rowsArchived: 0, weeksPruned: 0, rowsPruned: 0,
    bytes: 0, refusals: 0, anomalies: 0, error: null, durationMs: 41_000, runId: null, runUrl: ghRun(t),
    ...over,
  });
  // Per-table weekly volume: a chatty log table and a much smaller audit trail.
  const VOLUME: Record<string, { rows: number; spread: number; bytesPerRow: number }> = {
    "public.api_logs": { rows: 45_000, spread: 10_000, bytesPerRow: 64 },
    "public.audit_events": { rows: 8_000, spread: 4_000, bytesPerRow: 88 },
  };
  /** A plausible fingerprint. Never published — the scrub drops it — but the record carries one. */
  const fakeDigest = (label: string): string =>
    [...label].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16_777_619) >>> 0), 2_166_136_261).toString(16).padStart(16, "0");
  const fullPart = (part: number, rows: number, label: string, bytesPerRow: number): ArchivedPart => ({
    part, role: "full", rowCount: rows, bytes: rows * bytesPerRow,
    fingerprint: { n: rows, digest: fakeDigest(`${label}#${part}`) },
  });

  /** What one table's store knows about one week, as the simulation walks forward. */
  interface SampleWeek {
    rows: number;
    state: "archived" | "pruned";
    parts: ArchivedPart[];
  }
  const books = new Map<string, Map<string, SampleWeek>>(SAMPLE_ARCHIVE_SPECS.map((s) => [s.table, new Map()]));
  // Rows go back further than archiving does, so the first runs work off a backlog — which is what
  // makes the oldest rows archived-and-pruned while the newest are not archived at all.
  const oldestRowAt = new Date(lastArchive - (SAMPLE_ARCHIVE_WEEKS + SAMPLE_BACKLOG_WEEKS) * WEEK_MS);

  /** Archive up to `maxWeeks` outstanding weeks; returns what the run would record. */
  const archiveSome = (spec: ArchiveSpec, at: Date, maxWeeks: number, commit: boolean) => {
    const book = books.get(spec.table)!;
    const v = VOLUME[spec.table];
    const weeks = eligibleWeeks({
      now: at, oldestRowAt, afterWeeks: spec.archiveAfterWeeks, maxWeeks, done: new Set(book.keys()),
    });
    let rowsArchived = 0;
    let bytes = 0;
    for (const w of weeks) {
      const rows = Math.round(v.rows + rand() * v.spread);
      rowsArchived += rows;
      bytes += rows * v.bytesPerRow;
      if (commit) {
        book.set(w.label, { rows, state: "archived", parts: [fullPart(1, rows, w.label, v.bytesPerRow)] });
      }
    }
    return { weeksArchived: weeks.length, rowsArchived, bytes };
  };

  for (let w = SAMPLE_ARCHIVE_WEEKS - 1; w >= 0; w--) {
    // Oldest run first: the store's state accumulates, so what a later run finds outstanding is
    // whatever the earlier ones did not get to.
    const t = lastArchive - w * WEEK_MS;
    const at = new Date(t);
    const runFailed = w === 10; // one `failure` in archive-table.ts stamps every table's record
    const dryRun = w === 8 ? ("source" as const) : ("none" as const);

    for (const spec of SAMPLE_ARCHIVE_SPECS) {
      if (runFailed) {
        archives.push(archiveRecord(t, spec.table, {
          ok: false, durationMs: 12_000, error: "archive: could not acquire the store lock",
        }));
        continue;
      }
      const book = books.get(spec.table)!;
      // A dry run reports what it WOULD have done and changes nothing; w === 3 is the week where
      // nothing was eligible at all — it ran, the database did not change, and the tooltip says so.
      const nothingEligible = w === 3;
      const { weeksArchived, rowsArchived, bytes } = nothingEligible
        ? { weeksArchived: 0, rowsArchived: 0, bytes: 0 }
        : archiveSome(spec, at, SAMPLE_MAX_WEEKS_PER_RUN, dryRun === "none");

      // The fingerprint gate declining to delete: not a breakage, but somebody must look.
      const refusing = w === 6 && spec.table === "public.api_logs";
      const prunable = [...book.entries()]
        .filter(([label, b]) => b.state === "archived" && isWeekEligible(parseWeekLabel(label), at, spec.pruneAfterWeeks))
        .slice(0, SAMPLE_MAX_PRUNES_PER_RUN);
      let weeksPruned = 0;
      let rowsPruned = 0;
      if (!refusing && dryRun === "none" && !nothingEligible) {
        for (const [, b] of prunable) {
          b.state = "pruned";
          weeksPruned++;
          rowsPruned += b.rows;
        }
      }

      archives.push(archiveRecord(t, spec.table, {
        ok: !refusing,
        dryRun,
        weeksArchived,
        rowsArchived,
        bytes,
        weeksPruned,
        rowsPruned,
        refusals: refusing ? 2 : 0,
        error: refusing ? "prune refused: live fingerprint does not match the manifest" : null,
      }));
    }

    // A manual backfill alongside the scheduled run — exercises the multi-run chooser in a column,
    // and eats into the backlog faster than the weekly cap allows.
    if (w === 14) {
      const spec = SAMPLE_ARCHIVE_SPECS[0];
      const backfill = t + 3 * 3_600_000;
      const done = archiveSome(spec, new Date(backfill), 3, true);
      archives.push(archiveRecord(backfill, spec.table, { mode: "archive", ...done, durationMs: 156_000 }));
    }
  }

  // One week that was re-archived: the original part is superseded and the newer `full` part is
  // what the week now holds. The scrub publishes only the active part's count, which is exactly
  // the property archiveIndex.test.ts pins.
  const superseded = [...books.get("public.api_logs")!.entries()].find(([, b]) => b.state === "archived");
  if (superseded) {
    const [label, b] = superseded;
    const grown = b.rows + 137;
    const perRow = VOLUME["public.api_logs"].bytesPerRow;
    b.parts = [
      { ...fullPart(1, b.rows, label, perRow), role: "superseded" },
      fullPart(2, grown, label, perRow),
    ];
    b.rows = grown;
  }

  for (const [table, book] of books) {
    for (const [label, b] of book) {
      index.push({
        table: shortTableName(table),
        record: { label, state: b.state, parts: b.parts, updatedAt: iso(lastArchive) },
      });
    }
  }

  return { runs, verifications, archives, archiveSpecs: SAMPLE_ARCHIVE_SPECS, index };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
