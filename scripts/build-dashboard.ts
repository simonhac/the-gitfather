// ─────────────────────────────────────────────────────────────────────────────
// Build the static backup-history dashboard (a single self-contained index.html).
//
//   tsx build-dashboard.ts [--sample] [--out PATH] [--upload]
//
//   --sample   use generated sample data instead of reading R2 (local preview)
//   --out      output path (default: ../dashboard/dist/index.html)
//   --upload   rclone-upload the result to the public dashboard bucket (r2dash remote)
//
// Reads the PRIVATE rich logs from R2 (_log/<FILE_BASENAME>/*.jsonl via the `r2`
// remote), maps them to the SCRUBBED PublicPayload (drops raw error text; keeps the
// project label + sizes per the privacy decision), esbuild-bundles dashboard/heatmap.ts,
// and inlines bundle + data into dashboard/template.html.
// ─────────────────────────────────────────────────────────────────────────────

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const label = process.env.DASHBOARD_LABEL || process.env.FILE_BASENAME || "database";
const hideLinks = process.env.DASHBOARD_HIDE_RUN_LINKS === "1";

function readLogDir(dir: string): { runs: LogRun[]; verifications: LogVerification[] } {
  const runs: LogRun[] = [];
  const verifications: LogVerification[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return { runs, verifications };
  }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(dir, f), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln);
        if (f.startsWith("runs-")) runs.push(o as LogRun);
        else if (f.startsWith("verifications-")) verifications.push(o as LogVerification);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return { runs, verifications };
}

function downloadLogsFromR2(): { runs: LogRun[]; verifications: LogVerification[] } {
  const bucket = process.env.R2_BUCKET;
  const basename = process.env.FILE_BASENAME;
  if (!bucket || !basename) throw new Error("R2_BUCKET / FILE_BASENAME must be set to read logs from R2");
  const dest = mkdtempSync(join(tmpdir(), "pg-log-"));
  execFileSync(
    "rclone",
    ["copy", `r2:${bucket}/_log/${basename}/`, dest, "--include", "*.jsonl", "--s3-no-check-bucket"],
    { stdio: "inherit" },
  );
  return readLogDir(dest);
}

function scrub(runs: LogRun[], verifications: LogVerification[]): PublicPayload {
  return {
    label,
    generatedAt: process.env.DASHBOARD_NOW || new Date().toISOString(),
    // Privacy: drop key + raw error text; keep label, sizes, tiers, run links (toggleable).
    runs: runs.map((r) => ({ t: r.ts, ok: r.ok, tiers: r.tiers, bytes: r.bytes, runUrl: hideLinks ? null : r.runUrl })),
    verifications: verifications.map((v) => ({ vt: v.verifiedTs, ok: v.ok, ratio: v.ratio })),
  };
}

function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

async function main(): Promise<void> {
  const { runs, verifications } = useSample
    ? makeSample(new Date())
    : logdir
      ? readLogDir(logdir)
      : downloadLogsFromR2();
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
    const dbucket = process.env.DASHBOARD_R2_BUCKET;
    if (!dbucket) throw new Error("DASHBOARD_R2_BUCKET must be set to --upload");
    execFileSync(
      "rclone",
      ["copyto", outPath, `r2dash:${dbucket}/index.html`, "--s3-no-check-bucket", "--header-upload", "Content-Type: text/html; charset=utf-8"],
      { stdio: "inherit" },
    );
    console.log(`dashboard: uploaded → r2dash:${dbucket}/index.html`);
  }
}

// ── Sample data (local preview only) ─────────────────────────────────────────
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
  const start = end - 400 * 86_400_000;
  const first = Math.ceil(start / (2 * 3_600_000)) * 2 * 3_600_000;
  for (let t = first; t <= end; t += 2 * 3_600_000) {
    const d = new Date(t);
    const ageDays = (end - t) / 86_400_000;
    const incident = ageDays > 4.6 && ageDays < 5.0;
    const failed = incident ? rand() < 0.5 : rand() < 0.015;
    const ts = d.toISOString().replace(".000", "");
    if (failed) {
      runs.push({ ts, ok: false, tiers: [], bytes: null, key: null, runId: null, runUrl: null, error: "pg_dump: server closed the connection unexpectedly" });
      continue;
    }
    const tiers: BackupTier[] = ["2hourly"];
    if (d.getUTCHours() === 16) {
      tiers.push("daily");
      if (d.getUTCDay() === 0) tiers.push("weekly");
      if (d.getUTCDate() === 1) tiers.push("monthly");
    }
    runs.push({ ts, ok: true, tiers, bytes: 9_200_000 + Math.floor(ageDays * 1500), key: null, runId: null, runUrl: "https://github.com/owner/repo/actions", error: null });
  }
  const daily = runs.filter((r) => r.ok && r.tiers.includes("daily")).map((r) => r.ts);
  for (let i = 0; i < daily.length; i += 7) {
    const drillRan = new Date(Date.parse(daily[i]) + 30 * 3_600_000);
    if (drillRan.getTime() > end) continue;
    verifications.push({ ts: drillRan.toISOString().replace(".000", ""), verifiedTs: daily[i], ok: rand() < 0.97, ratio: 0.97 + rand() * 0.03, runId: null, runUrl: null });
  }
  return { runs, verifications };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
