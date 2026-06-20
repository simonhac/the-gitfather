import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// Off-site, provider-independent Postgres backup → Cloudflare R2, with GFS tiering.
//
// Dumps with `pg_dump -Fc` (custom format), optionally encrypts, and uploads to R2 via the S3 API
// (rclone). Each run writes one object to the 2hourly/ tier and then *promotes* (server-side R2→R2
// copy — no re-dump, no re-upload) that same object into daily/weekly/monthly when the run lands on
// the configured anchor. Retention is enforced by R2 lifecycle rules + bucket locks per prefix (set
// out-of-band; see README), not by this script. Built for GitHub Actions but runnable locally.
//
// Slack: one message per day that updates in place — a ✅/❌ + HH:MM tick per 2-hourly run (see
// lib/slack.ts). A failed run appends ❌ and posts a loud, mentioning threaded alert.
//
// Usage:
//   PROFILE=profiles/example.env npx tsx scripts/backup-pg-to-r2.ts
//
// Required env (credentials — from GitHub secrets, NOT the profile):
//   PG_BACKUP_DATABASE_URL   postgres://USER:PW@HOST:5432/DB?sslmode=require
//                            ^ if your provider has a connection pooler, prefer its SESSION pooler.
//   R2_ACCOUNT_ID            endpoint = https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
//   R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
// Optional env: SLACK_BOT_TOKEN / SLACK_CHANNEL / HEARTBEAT_URL / FORCE_TIERS / AGE_RECIPIENT
// ─────────────────────────────────────────────────────────────────────────────

import { statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupSchema, reportConfigError } from "./lib/config.js";
import { run, runToFile, pipeToFile, commandExists, bestEffort } from "./lib/proc.js";
import { computeTiers, runOrigin } from "./lib/schedule.js";
import { appendRun } from "./runlog.js";
import { slackEnabled, slackPost, slackDailyRecord, dailyLabel, alertWebhook } from "./lib/slack.js";
import type { BackupTier } from "./lib/backupTypes.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC `date +%Y%m%dT%H%M%SZ`. */
function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** Best-effort dead-man's-switch ping (curl -fsS -m 10 equivalent). */
async function pingHeartbeat(url: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) process.stderr.write("warning: heartbeat ping failed\n");
  } catch {
    process.stderr.write("warning: heartbeat ping failed\n");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort ❌ when config validation fails BEFORE the normal flow could record anything — so the row
 * shows ❌, not ⬜ (indistinguishable from a dropped scheduler tick). `cfg` is unavailable, so it reads
 * raw process.env and no-ops unless it has everything needed to reach R2 + Slack (true for the #165 case,
 * where only the DB URL was empty). NEVER echoes a config value — the message is generic (secret-safe).
 */
async function recordConfigFailure(): Promise<void> {
  const basename = process.env.FILE_BASENAME;
  const acct = process.env.R2_ACCOUNT_ID,
    bkt = process.env.R2_BUCKET;
  const key = process.env.R2_ACCESS_KEY_ID,
    sec = process.env.R2_SECRET_ACCESS_KEY;
  if (!slackEnabled() || !basename || !acct || !bkt || !key || !sec) return; // can't record → leave as ⬜
  process.env.RCLONE_CONFIG_R2_TYPE = "s3";
  process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
  process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = key;
  process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = sec;
  process.env.RCLONE_CONFIG_R2_ENDPOINT = `https://${acct}.r2.cloudflarestorage.com`;
  const now = new Date();
  const stamp = utcStamp(now);
  const runTsIso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` +
    `T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const label = dailyLabel(now);
  const origin = runOrigin(process.env.GITHUB_EVENT_NAME, process.env.BACKUP_TRIGGER);
  const msg = "config validation failed"; // GENERIC — never include the offending value (secret-safe)
  const dayts = (await bestEffort("slack config-fail tick", () => slackDailyRecord(false, label, "", origin, now))) ?? "";
  await bestEffort("slack config-fail alert", () =>
    slackPost(`${process.env.SLACK_ALERT_MENTION || "<!here>"} 🔴 *${basename}* backup FAILED at ${label} — ${msg}`, {
      thread: dayts,
      broadcast: true,
    }),
  );
  await bestEffort("alert webhook", () => alertWebhook(`🔴 ${basename} backup FAILED at ${label} — ${msg}`));
  await bestEffort("runlog config-fail", () => appendRun({ ts: runTsIso, ok: false, tiers: [], error: msg }));
}

async function main(): Promise<void> {
  // Validate + type all config up front (zod). On any missing/malformed var, record a best-effort ❌
  // on today's Slack row (so a config crash is distinguishable from a dropped tick — it is NOT ⬜),
  // print the same aggregated report (names only), then exit 1 — before any dump/upload. See lib/config.ts.
  const parsed = backupSchema.safeParse(process.env);
  if (!parsed.success) {
    await recordConfigFailure();
    reportConfigError(parsed.error);
    process.exit(1);
  }
  const cfg = parsed.data;
  const {
    BACKUP_PREFIX: backupPrefix,
    FILE_BASENAME: fileBasename,
    PG_BACKUP_DATABASE_URL: dbUrl,
    R2_ACCOUNT_ID: r2Account,
    R2_BUCKET: r2Bucket,
    R2_ACCESS_KEY_ID: r2Key,
    R2_SECRET_ACCESS_KEY: r2Secret,
    ENCRYPTION: encryption,
    MIN_BYTES: minBytes,
    ANCHOR_HOUR_UTC: anchorHour,
  } = cfg;

  const now = new Date();
  const stamp = utcStamp(now);
  const runTsIso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` +
    `T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const endpoint = `https://${r2Account}.r2.cloudflarestorage.com`;
  const label = dailyLabel(now); // HH:MM tick label in DISPLAY_TZ

  // Row marker: 🖐️ for hand-kicked runs, 🩹 for a staleness self-heal catch-up, none for cron. See runOrigin.
  const origin = runOrigin(process.env.GITHUB_EVENT_NAME, process.env.BACKUP_TRIGGER);

  // rclone S3 remote configured purely from env (no rclone.conf on disk). Set early so fail() and
  // the Slack daily-row state can reach R2 even if a failure happens before the upload.
  process.env.RCLONE_CONFIG_R2_TYPE = "s3";
  process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
  process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = r2Key;
  process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = r2Secret;
  process.env.RCLONE_CONFIG_R2_ENDPOINT = endpoint;

  // Object extension per encryption mode. Unknown mode is a plain config error (no Slack).
  let ext: string;
  switch (encryption) {
    case "none":
      ext = "dump";
      break;
    case "age":
      ext = "dump.age";
      break;
    case "aes-gcm":
      ext = "dump.enc";
      break;
    default:
      process.stderr.write(`ERROR: unknown ENCRYPTION='${encryption}'\n`);
      process.exit(1);
  }
  const filename = `${fileBasename}-${stamp}.${ext}`;

  const tmp = mkdtempSync(join(tmpdir(), "pg-backup-"));
  const out = join(tmp, filename);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  // On failure: record ❌ on today's row, then post a loud mentioning alert threaded under it. All
  // best-effort — Slack problems must never mask the real error.
  const fail = async (msg: string): Promise<never> => {
    process.stderr.write(`ERROR: ${msg}\n`);
    if (slackEnabled()) {
      const dayts = (await bestEffort("slack fail tick", () => slackDailyRecord(false, label, "", origin, now))) ?? "";
      await bestEffort("slack fail alert", () =>
        slackPost(
          `${process.env.SLACK_ALERT_MENTION || "<!here>"} 🔴 *${fileBasename}* backup FAILED at ${label} — ${msg}`,
          { thread: dayts, broadcast: true },
        ),
      );
    }
    await bestEffort("alert webhook", () => alertWebhook(`🔴 ${fileBasename} backup FAILED at ${label} — ${msg}`));
    await bestEffort("runlog fail", () => appendRun({ ts: runTsIso, ok: false, tiers: [], error: msg }));
    cleanup();
    process.exit(1);
  };

  if (!commandExists("pg_dump")) await fail("pg_dump not found");
  if (!commandExists("rclone")) await fail("rclone not found");

  // ── Dump (+ optional encrypt) → out ────────────────────────────────────────
  const dumpFlags = cfg.PG_DUMP_FLAGS; // already split (defaults to -Fc --no-owner --no-privileges)

  console.log(`Dumping Postgres → ${out} (ENCRYPTION=${encryption}) ...`);
  if (encryption === "none") {
    const code = await runToFile("pg_dump", [...dumpFlags, dbUrl], out);
    if (code !== 0) await fail("pg_dump failed");
  } else if (encryption === "age") {
    if (!commandExists("age")) await fail("ENCRYPTION=age but 'age' not found");
    // Presence is already enforced by the schema (age ⇒ AGE_RECIPIENT); guard kept as defence-in-depth.
    const recipient = cfg.AGE_RECIPIENT;
    if (!recipient) await fail("ENCRYPTION=age requires AGE_RECIPIENT");
    const code = await pipeToFile(
      { cmd: "pg_dump", args: [...dumpFlags, dbUrl] },
      { cmd: "age", args: ["-r", recipient!] },
      out,
    );
    if (code !== 0) await fail("pg_dump | age pipeline failed");
  } else {
    // aes-gcm
    await fail("ENCRYPTION=aes-gcm not implemented yet (encryption is a planned follow-up)");
  }

  const size = statSync(out).size;
  console.log(`Dump size: ${Math.floor(size / 1024 / 1024)} MB (${size} bytes)`);
  if (size < minBytes) await fail(`dump suspiciously small (${size} < ${minBytes}) — not uploading`);

  // ── Which tiers does this run belong to? ───────────────────────────────────
  // Always 2hourly; the anchor-hour run is also daily, +weekly on Sun, +monthly on the 1st (UTC).
  const tiers = computeTiers(now, anchorHour, cfg.FORCE_TIERS);
  console.log(`Tiers for this run: ${tiers.join(" ")}`);

  // Upload once to the first tier (always 2hourly), then server-side copy to the rest. Single-PUT
  // (cutoff above dump size) is atomic — no multipart, no orphaned parts. R2 may log a benign "501
  // NotImplemented" for the x-amz-checksum-crc32 header the AWS SDK adds; rclone retries without it.
  const first = tiers[0];
  const firstKey = `${backupPrefix}/${first}/${filename}`;
  console.log(`Uploading → r2://${r2Bucket}/${firstKey}`);
  const upCode = await run("rclone", [
    "copyto",
    out,
    `r2:${r2Bucket}/${firstKey}`,
    "--s3-no-check-bucket",
    "--s3-upload-cutoff=4Gi",
    "--stats-one-line",
  ]);
  if (upCode !== 0) await fail("R2 upload failed");

  for (const tier of tiers.slice(1)) {
    const destKey = `${backupPrefix}/${tier}/${filename}`;
    console.log(`Promoting → r2://${r2Bucket}/${destKey}`);
    const promoCode = await run("rclone", [
      "copyto",
      `r2:${r2Bucket}/${firstKey}`,
      `r2:${r2Bucket}/${destKey}`,
      "--s3-no-check-bucket",
      "--stats-one-line",
    ]);
    if (promoCode !== 0) await fail(`R2 promotion copy to ${tier} failed`);
  }

  // Marker for the Slack row: which durable tiers this run was promoted to.
  const promoted = tiers.filter((t) => t !== "2hourly").join(",");
  const marker = promoted ? `📅(${promoted})` : "";

  console.log(`✓ Backup complete: ${filename} (${Math.floor(size / 1024 / 1024)} MB) → tiers: ${tiers.join(" ")}`);
  await bestEffort("slack ok tick", () => slackDailyRecord(true, label, marker, origin, now));
  await bestEffort("runlog ok", () =>
    appendRun({ ts: runTsIso, ok: true, tiers: tiers as BackupTier[], bytes: size, key: firstKey }),
  );

  // Dead-man's-switch ping (success only) — its absence is the staleness signal.
  if (cfg.HEARTBEAT_URL) {
    const heartbeatUrl = cfg.HEARTBEAT_URL;
    await bestEffort("heartbeat", () => pingHeartbeat(heartbeatUrl));
  }

  cleanup();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
