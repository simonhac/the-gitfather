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
import { HOURS_PER_SLOT } from "./lib/backupTypes.js";
import type { LogRun, LogVerification, PublicPayload, BackupTier } from "./lib/backupTypes.js";

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

function scrub(runs: LogRun[], verifications: LogVerification[]): PublicPayload {
  return {
    label,
    generatedAt: process.env.DASHBOARD_NOW || new Date().toISOString(),
    retention, // per-tier windows in effect (from the profile; defaults otherwise) — drives expiry + subtitle
    // Privacy: drop key + raw error text; keep label, sizes, tiers, run links (toggleable).
    runs: runs.map((r) => ({ t: r.ts, ok: r.ok, tiers: r.tiers, bytes: r.bytes, runUrl: hideLinks ? null : r.runUrl })),
    // kind drives the tooltip wording (restore vs byte-check); counts/reason/key/tier stay private.
    verifications: verifications.map((v) => ({ vt: v.verifiedTs, ok: v.ok, ratio: v.ratio, kind: v.kind })),
  };
}

function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

async function main(): Promise<void> {
  let runs: LogRun[];
  let verifications: LogVerification[];
  if (useSample) {
    ({ runs, verifications } = makeSample(new Date()));
  } else if (logdir) {
    ({ runs, verifications } = readLogDir(logdir));
  } else {
    if (!cfg.credentials.r2.bucket || !cfg.name) throw new Error("R2_BUCKET / profile name must be set to read logs from R2");
    ({ runs, verifications } = downloadLogsFromR2(cfg.credentials.r2.bucket, cfg.name));
  }
  const payload = scrub(runs, verifications);
  console.log(`dashboard: ${payload.runs.length} runs, ${payload.verifications.length} verifications (label="${label}")`);

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
    define: { "process.env.DISPLAY_TZ": JSON.stringify(process.env.DISPLAY_TZ || "UTC") },
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
function makeSample(now: Date): { runs: LogRun[]; verifications: LogVerification[] } {
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
      runs.push({ ts, ok: false, tiers: [], bytes: null, key: null, sha256: null, counts: null, runId: null, runUrl: ghRun(t), error, durationMs: 26_000 });
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

    runs.push({ ts, ok: true, tiers, bytes, key: null, sha256: null, counts: null, runId: null, runUrl: ghRun(t), error: null, durationMs: 92_000 });
  }

  // A couple of slots with more than one run, to exercise the multi-run rendering: when two
  // runs land in the same display slot (a manual rerun, or a failure that's retried),
  // the cell gets a corner notch — and a mix of success + failure splits it diagonally. Placed
  // in the last ~2 days so the 2hourly copies are still retained (green), not aged-out grey.
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000", "");
  const bucket = (hoursAgo: number) => Math.floor((end - hoursAgo * 3_600_000) / slotMs) * slotMs;

  // (a) Mixed slot: the scheduled run (already added by the loop, OK) plus a manual rerun ~40 min
  //     later that failed → diagonal split (green/red) + notch.
  const mixed = bucket(20) + 40 * 60_000;
  runs.push({ ts: iso(mixed), ok: false, tiers: [], bytes: null, key: null, sha256: null, counts: null, runId: null, runUrl: ghRun(mixed), error: "pg_dump: canceled statement due to lock_timeout", durationMs: 31_000 });

  // (b) Multi-success slot: the scheduled run plus a successful manual rerun ~50 min later → notch.
  const rerun = bucket(40) + 50 * 60_000;
  runs.push({ ts: iso(rerun), ok: true, tiers: ["2hourly"], bytes: 4_840_000_000, key: null, sha256: null, counts: null, runId: null, runUrl: ghRun(rerun), error: null, durationMs: 88_000 });

  // One restore drill per weekly anchor (Sunday daily backup), run ~30 h later. ~97% pass.
  const weekly = runs.filter((r) => r.ok && r.tiers.includes("weekly")).map((r) => r.ts);
  for (const verifiedTs of weekly) {
    const drillRan = new Date(Date.parse(verifiedTs) + 30 * 3_600_000);
    if (drillRan.getTime() > end) continue;
    verifications.push({ ts: drillRan.toISOString().replace(".000", ""), verifiedTs, ok: rand() < 0.97, ratio: 0.97 + rand() * 0.03, runId: null, runUrl: null });
  }
  return { runs, verifications };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
