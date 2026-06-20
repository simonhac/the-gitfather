import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// Restore drill — proves the latest off-site R2 dump actually restores. The "0 restore errors" leg
// of 3-2-1-1-0; a backup isn't real until restored.
//
// Pulls the newest object under $BACKUP_PREFIX from R2, decrypts if needed, pg_restores it into a
// throwaway target, and asserts the restored sentinel-table row count is within tolerance of the
// live count (catches both a truncated dump and a stale/stuck backup). Best-effort Slack alert +
// non-zero exit on failure.
//
// Usage:
//   PROFILE=profiles/example.env npx tsx scripts/restore-drill-pg.ts
//
// Required env (credentials — from GitHub secrets, NOT the profile):
//   R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   read access to the bucket
//   DRILL_DATABASE_URL        throwaway Postgres to restore into (e.g. the CI postgres:17 service)
//   PG_LIVE_DATABASE_URL      live DB — read-only, for the expected row count
// Optional env: SLACK_BOT_TOKEN / SLACK_CHANNEL ; AGE_IDENTITY (only if backups are .age)
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadDrillConfig } from "./lib/config.js";
import { run, runToFile, capture, commandExists } from "./lib/proc.js";
import { appendVerify } from "./runlog.js";
import { slackOneoff } from "./lib/slack.js";

/** ISO-8601 UTC to seconds precision (matches bash `date -u +%Y-%m-%dT%H:%M:%SZ`). */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

async function main(): Promise<void> {
  // Validate + type all config up front (zod); fails fast with one aggregated report. See lib/config.ts.
  const cfg = loadDrillConfig();
  const {
    BACKUP_PREFIX: backupPrefix,
    DRILL_SENTINEL_TABLE: sentinel,
    R2_ACCOUNT_ID: r2Account,
    R2_BUCKET: r2Bucket,
    R2_ACCESS_KEY_ID: r2Key,
    R2_SECRET_ACCESS_KEY: r2Secret,
    DRILL_DATABASE_URL: drillUrl,
    PG_LIVE_DATABASE_URL: liveUrl,
    MIN_RATIO: minRatio,
    FILE_BASENAME: fileBasename,
  } = cfg;

  const endpoint = `https://${r2Account}.r2.cloudflarestorage.com`;

  const tmp = mkdtempSync(join(tmpdir(), "pg-drill-"));
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

  const fail = async (msg: string): Promise<never> => {
    process.stderr.write(`ERROR: ${msg}\n`);
    await slackOneoff(`🔴 PG restore-drill FAILED (${fileBasename}): ${msg}`, true).catch(() => {});
    cleanup();
    process.exit(1);
  };

  if (!commandExists("rclone")) await fail("rclone not found");
  if (!commandExists("pg_restore")) await fail("pg_restore not found");
  if (!commandExists("psql")) await fail("psql not found");

  process.env.RCLONE_CONFIG_R2_TYPE = "s3";
  process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
  process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = r2Key;
  process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = r2Secret;
  process.env.RCLONE_CONFIG_R2_ENDPOINT = endpoint;

  // Newest dump = the newest object in 2hourly/. Every run writes there; daily/weekly/monthly are
  // server-side copies of OLDER 2hourly objects. Listing 2hourly/ NON-recursively keeps the lexical
  // sort genuinely chronological (the same way check-staleness.ts picks "newest"), so the drill
  // verifies the latest dump — not an older durable copy. (This deliberately changes the original
  // bash behavior of `lsf -R | sort | tail -1`, which sorted by the tier prefix first and so picked
  // the newest of the lexically-last tier — usually a weekly copy up to ~7 days old.)
  console.log(`Finding newest object under r2:${r2Bucket}/${backupPrefix}/2hourly/ ...`);
  const ls = capture("rclone", [
    "lsf",
    "--files-only",
    `r2:${r2Bucket}/${backupPrefix}/2hourly/`,
    "--s3-no-check-bucket",
  ]);
  const objs = ls.out.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  const newest = objs.length ? objs[objs.length - 1] : "";
  if (!newest) await fail(`no objects under ${backupPrefix}/2hourly/`);
  const key = `2hourly/${newest}`;
  console.log(`Latest: ${backupPrefix}/${key}`);

  const obj = join(tmp, "obj");
  const dlCode = await run("rclone", [
    "copyto",
    `r2:${r2Bucket}/${backupPrefix}/${key}`,
    obj,
    "--s3-no-check-bucket",
  ]);
  if (dlCode !== 0) await fail("download failed");

  // ── Decrypt / decompress to a plain custom-format dump ─────────────────────
  const dump = join(tmp, "restore.dump");
  if (key.endsWith(".dump.age")) {
    if (!commandExists("age")) await fail("object is .age but 'age' not found");
    const identity = cfg.AGE_IDENTITY;
    if (!identity) await fail("object is .age but AGE_IDENTITY is unset");
    // file path → use as-is; otherwise treat as a literal key (bash `-f` = regular file only).
    let isRegularFile = false;
    try {
      isRegularFile = statSync(identity!).isFile();
    } catch {
      /* not a path */
    }
    let idfile: string;
    if (isRegularFile) {
      idfile = identity!;
    } else {
      idfile = join(tmp, "id");
      writeFileSync(idfile, identity!, { mode: 0o600 });
    }
    const code = await runToFile("age", ["-d", "-i", idfile, obj], dump);
    if (code !== 0) await fail("age decrypt failed");
  } else if (key.endsWith(".dump.enc")) {
    await fail("object is aes-gcm encrypted but decrypt is not implemented yet (encryption is a planned follow-up)");
  } else {
    copyFileSync(obj, dump);
  }

  // ── Restore into the throwaway target ──────────────────────────────────────
  // Restoring provider-managed schemas into vanilla Postgres emits benign errors (missing
  // roles/extensions); --disable-triggers sidesteps cross-schema FK ordering. The row-count
  // assertion below — not a clean restore — is the real gate, so pg_restore's exit is NOT fatal.
  console.log("Restoring into the drill target ...");
  const restoreCode = await run("pg_restore", [
    "--no-owner",
    "--no-privileges",
    "--no-comments",
    "--disable-triggers",
    "-j",
    "4",
    "-d",
    drillUrl,
    dump,
  ]);
  console.log(restoreCode === 0 ? "pg_restore: clean" : "pg_restore: completed with warnings (continuing to row-count check)");

  const restored = (table: string): string =>
    capture("psql", [drillUrl, "-tAc", `SELECT count(*) FROM public.${table}`]).out.replace(/\s/g, "");
  const liveEst = (table: string): string =>
    capture("psql", [
      liveUrl,
      "-tAc",
      `SELECT n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' AND relname='${table}'`,
    ]).out.replace(/\s/g, "");

  const sentRestored = restored(sentinel);
  const sentLive = liveEst(sentinel);
  console.log(`Sentinel public.${sentinel}: restored=${sentRestored || "?"}  (live≈${sentLive || "?"})`);

  const restoredNum = Number(sentRestored);
  const liveNum = Number(sentLive);
  if (!(sentRestored !== "" && restoredNum > 0)) await fail(`restored ${sentinel} is empty/zero`);
  if (!(sentLive !== "" && liveNum > 0)) await fail(`could not read live ${sentinel} estimate`);

  // restored should be >= MIN_RATIO × live (allows rows added since the backup; catches truncation).
  if (!(restoredNum >= liveNum * minRatio)) {
    await fail(`restored ${sentinel} ${sentRestored} < ${minRatio}× live ${sentLive} — truncated or stale`);
  }

  // Extra tables: simply non-empty.
  for (const t of cfg.DRILL_EXTRA_TABLES) {
    const n = restored(t);
    console.log(`  extra public.${t}: restored=${n || "?"}`);
    if (!(n !== "" && Number(n) > 0)) await fail(`restored ${t} is empty/zero`);
  }

  console.log(
    `✓ Restore drill PASSED: public.${sentinel} ${sentRestored} ≥ ${minRatio}× live ${sentLive} (${key})`,
  );
  await slackOneoff(
    `✅ PG restore-drill OK (${fileBasename}) — ${sentinel} ${sentRestored} (≥${minRatio}× live ${sentLive}) — ${key}`,
  ).catch(() => {});

  // Record the verification so the dashboard can mark that dump's cell as restore-verified. The dump
  // stamp (YYYYMMDDTHHMMSSZ) embedded in the key maps to the matching run-log entry's ts.
  const stampMatch = basename(key).match(/[0-9]{8}T[0-9]{6}Z/);
  if (stampMatch) {
    const s = stampMatch[0];
    const verifiedTs =
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` +
      `T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
    const ratio = liveNum > 0 ? Number((restoredNum / liveNum).toFixed(4)) : null;
    appendVerify({ ts: isoSeconds(new Date()), verifiedTs, ok: true, ratio });
  }

  cleanup();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
