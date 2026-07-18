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
//   PROFILE=profiles/example.yaml npx tsx scripts/backup-pg-to-r2.ts
//
// Required env (credentials — from GitHub secrets, NOT the profile):
//   PG_BACKUP_DATABASE_URL   postgres://USER:PW@HOST:5432/DB?sslmode=require
//                            ^ if your provider has a connection pooler, prefer its SESSION pooler.
//   R2_ACCOUNT_ID            endpoint = https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
//   R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
// Optional env: SLACK_BOT_TOKEN / SLACK_CHANNEL / HEARTBEAT_URL / AGE_RECIPIENT / FORCE_TIERS.
// All other config comes from $PROFILE (the YAML profile).
// ─────────────────────────────────────────────────────────────────────────────

import { statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupSchema, reportConfigError, peekProfile } from "./lib/config.js";
import { buildRawProfile } from "./lib/profile.js";
import { pgConn } from "./lib/pgconn.js";
import { run, runToFile, pipeToFile, commandExists, bestEffort, sha256File, capture } from "./lib/proc.js";
import { computeTiers, runOrigin } from "./lib/schedule.js";
import { appendRun } from "./runlog.js";
import { githubLogUrl } from "./lib/github.js";
import { slackEnabled, slackPost, slackDailyRecord, dailyLabel, alertWebhook, failAlertText } from "./lib/slack.js";
import type { BackupTier } from "./lib/backupTypes.js";

// Captured at module load (≈ process start) so both recordConfigFailure() and main() can stamp the
// run-log with the whole-script wall time — see the appendRun({ durationMs }) call sites below.
const SCRIPT_START_MS = Date.now();

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
  // The profile `name` comes from the YAML (read tolerantly); R2 creds are env. peekProfile() never exits,
  // so this works even though task-level config validation just failed.
  const basename = peekProfile()?.name;
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
  const mention = peekProfile()?.slack.alertMention || "<!here>";
  const logUrl = await githubLogUrl();
  await bestEffort("slack config-fail alert", () =>
    slackPost(`${mention} ${failAlertText(`FAILED at ${label}`, msg, logUrl)}`, {
      thread: dayts,
      broadcast: true,
    }),
  );
  await bestEffort("alert webhook", () => alertWebhook(`🔴 ${basename} backup FAILED at ${label} — ${msg}`));
  await bestEffort("runlog config-fail", () =>
    appendRun({ ts: runTsIso, ok: false, tiers: [], error: msg, durationMs: Date.now() - SCRIPT_START_MS }),
  );
}

async function main(): Promise<void> {
  // Validate + type all config up front (zod). On any missing/malformed var, record a best-effort ❌
  // on today's Slack row (so a config crash is distinguishable from a dropped tick — it is NOT ⬜),
  // print the same aggregated report (names only), then exit 1 — before any dump/upload. See lib/config.ts.
  const parsed = backupSchema.safeParse(buildRawProfile());
  if (!parsed.success) {
    await recordConfigFailure();
    reportConfigError(parsed.error);
    process.exit(1);
  }
  const cfg = parsed.data;
  // All required by backupSchema's refinements (non-null below).
  const backupPrefix = cfg.backupPrefix!;
  const fileBasename = cfg.name!;
  const dbUrl = cfg.credentials.databaseUrl!;
  const r2Account = cfg.credentials.r2.accountId!;
  const r2Bucket = cfg.credentials.r2.bucket!;
  const r2Key = cfg.credentials.r2.accessKeyId!;
  const r2Secret = cfg.credentials.r2.secretAccessKey!;
  const encryption = cfg.encryption;
  const minBytes = cfg.dump.minBytes;
  const anchorHour = cfg.anchorHourUtc;

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
      const logUrl = await githubLogUrl();
      await bestEffort("slack fail alert", () =>
        slackPost(`${cfg.slack.alertMention || "<!here>"} ${failAlertText(`FAILED at ${label}`, msg, logUrl)}`, {
          thread: dayts,
          broadcast: true,
        }),
      );
    }
    await bestEffort("alert webhook", () => alertWebhook(`🔴 ${fileBasename} backup FAILED at ${label} — ${msg}`));
    await bestEffort("runlog fail", () =>
      appendRun({ ts: runTsIso, ok: false, tiers: [], error: msg, durationMs: Date.now() - SCRIPT_START_MS }),
    );
    cleanup();
    process.exit(1);
  };

  if (!commandExists("pg_dump")) await fail("pg_dump not found");
  if (!commandExists("rclone")) await fail("rclone not found");

  // ── Dump (+ optional encrypt) → out ────────────────────────────────────────
  const dumpFlags = cfg.dump.flags; // already split (defaults to -Fc --no-owner --no-privileges)
  // Keep the DB password off pg_dump's argv (visible in `ps`) — it rides in a 0600 PGPASSFILE instead.
  const db = pgConn(dbUrl, tmp);

  // Dump-time reference count of the drill sentinel table. Taken here — just before the dump, so it
  // reflects ~the snapshot pg_dump is about to capture — and recorded in the run-log. The restore-drill /
  // durable-verify live-ratio gate compares the RESTORED count against THIS (restored ≈ dump-time), instead
  // of a live-now estimate that drifts upward as an active table grows between dump and verify (the false
  // "truncated or stale" it used to raise). Probed exactly as the drill will (`public.<table>`, an exact
  // count(*)). Best-effort: no sentinel / no psql / a failed count just omits it → the drill falls back to
  // the live estimate. null (not {}) when there's nothing to record, so a legacy-shaped run stays null.
  let dumpCounts: Record<string, number> | null = null;
  const sentinelTable = cfg.drill.rowCountTable;
  if (sentinelTable && commandExists("psql")) {
    const r = capture("psql", [db.safeUrl, "-tAc", `SELECT count(*) FROM public.${sentinelTable}`], db.env);
    const n = Number(r.out.replace(/\s/g, ""));
    if (r.ok && Number.isFinite(n)) {
      dumpCounts = { [sentinelTable]: n };
      console.log(`Dump-time row count public.${sentinelTable}: ${n}`);
    } else {
      process.stderr.write(`warning: could not count public.${sentinelTable} at dump time — the drill will fall back to the live estimate\n`);
    }
  }

  console.log(`Dumping Postgres → ${out} (ENCRYPTION=${encryption}) ...`);
  if (encryption === "none") {
    const code = await runToFile("pg_dump", [...dumpFlags, db.safeUrl], out, db.env);
    if (code !== 0) await fail("pg_dump failed");
  } else if (encryption === "age") {
    if (!commandExists("age")) await fail("ENCRYPTION=age but 'age' not found");
    // Presence is already enforced by the schema (age ⇒ AGE_RECIPIENT); guard kept as defence-in-depth.
    const recipient = cfg.credentials.age.recipient;
    if (!recipient) await fail("ENCRYPTION=age requires AGE_RECIPIENT");
    const code = await pipeToFile(
      { cmd: "pg_dump", args: [...dumpFlags, db.safeUrl] },
      { cmd: "age", args: ["-r", recipient!] },
      out,
      db.env,
    );
    if (code !== 0) await fail("pg_dump | age pipeline failed");
  } else {
    // aes-gcm
    await fail("ENCRYPTION=aes-gcm not implemented yet (encryption is a planned follow-up)");
  }

  const size = statSync(out).size;
  console.log(`Dump size: ${Math.floor(size / 1024 / 1024)} MB (${size} bytes)`);
  if (size < minBytes) await fail(`dump suspiciously small (${size} < ${minBytes}) — not uploading`);

  // ── Structural validation (#4): prove the dump is a parseable custom-format archive ────────
  // `pg_restore -l` lists the TOC (cheap — header + table of contents, not the data); a corrupt or
  // truncated archive can't be listed, and a real data dump has ≥1 TABLE/TABLE DATA entry. This
  // catches a >dump.min-bytes-but-corrupt dump BEFORE it's reported as a successful backup. Only the
  // plaintext (none-mode) is checkable here without a key; age is covered by integrity.verify-after-upload / the drill.
  if (encryption === "none" && cfg.integrity.checkStructure) {
    if (!commandExists("pg_restore")) {
      process.stderr.write("warning: integrity.check-structure is on but pg_restore not found — skipping TOC validation\n");
    } else {
      const toc = capture("pg_restore", ["-l", out]);
      if (!toc.ok) await fail("dump is not a parseable pg_dump archive (pg_restore -l failed)");
      const tableEntries = toc.out.split("\n").filter((l) => /\bTABLE( DATA)?\b/.test(l)).length;
      if (tableEntries === 0) await fail("dump TOC has no TABLE entries — suspect an empty or schema-only dump");
      console.log(`Structural check: ${tableEntries} TABLE/TABLE DATA TOC entries — archive is parseable`);
    }
  }

  // ── Content hash (#1): SHA-256 of the EXACT bytes we upload (ciphertext for age) ───────────
  // Streamed (never buffers the dump on the heap). Best-effort — a hash hiccup must not fail an
  // otherwise-good backup. Recorded in the run-log as the durable hash-verify baseline.
  let sha256: string | null = null;
  if (cfg.integrity.checksum) {
    sha256 = (await bestEffort("sha256", () => sha256File(out))) ?? null;
    if (sha256) console.log(`SHA-256: ${sha256}`);
  }

  // ── Which tiers does this run belong to? ───────────────────────────────────
  // Always 2hourly; the anchor-hour run is also daily, +weekly on Sun, +monthly on the 1st (UTC).
  // FORCE_TIERS is a per-run override (manual/self-heal dispatch), so it stays an env read, not profile config.
  const forceTiers = (process.env.FORCE_TIERS ?? "").split(/\s+/).filter(Boolean) as BackupTier[];
  const tiers = computeTiers(now, anchorHour, forceTiers);
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

  // ── Opt-in post-upload self-verify (#1/#4): re-fetch what R2 actually stored and prove it ──
  // Default off (a single-PUT upload is atomic; a re-download every 2h burns runner minutes). When on,
  // this is the ONLY backup-time structural check for age (needs age + AGE_IDENTITY to decrypt).
  if (cfg.integrity.verifyAfterUpload) {
    console.log("Post-upload verify: re-fetching the stored object …");
    const verifyObj = join(tmp, "verify.obj");
    const dl = await run("rclone", ["copyto", `r2:${r2Bucket}/${firstKey}`, verifyObj, "--s3-no-check-bucket"]);
    if (dl !== 0) await fail("post-upload verify: re-download failed");
    // (a) Byte integrity: the re-fetched object must hash to exactly what we uploaded.
    const localSha = sha256 ?? (await bestEffort("sha256", () => sha256File(out))) ?? null;
    if (localSha) {
      const got = (await bestEffort("verify sha256", () => sha256File(verifyObj))) ?? null;
      if (got && got.toLowerCase() !== localSha.toLowerCase()) {
        await fail(`post-upload sha256 mismatch (local ${localSha.slice(0, 12)}… vs R2 ${got.slice(0, 12)}…)`);
      }
    }
    // (b) Structural: decrypt if age, then pg_restore -l on the re-fetched bytes.
    if (!commandExists("pg_restore")) {
      process.stderr.write("warning: integrity.verify-after-upload is on but pg_restore not found — skipping the structural re-check\n");
    } else {
      let toCheck = verifyObj;
      if (encryption === "age") {
        const identity = cfg.credentials.age.identity;
        if (!commandExists("age") || !identity) await fail("post-upload verify: ENCRYPTION=age needs age + AGE_IDENTITY to decrypt");
        let idfile = identity!;
        try {
          if (!statSync(identity!).isFile()) throw new Error("not a file");
        } catch {
          idfile = join(tmp, "verify.id");
          writeFileSync(idfile, identity!, { mode: 0o600 });
        }
        const plain = join(tmp, "verify.dump");
        const dc = await runToFile("age", ["-d", "-i", idfile, verifyObj], plain);
        if (dc !== 0) await fail("post-upload verify: age decrypt failed");
        toCheck = plain;
      }
      const toc = capture("pg_restore", ["-l", toCheck]);
      if (!toc.ok) await fail("post-upload verify: the stored object is not a parseable archive");
      console.log("Post-upload verify: OK (byte + structural)");
    }
  }

  // Marker for the Slack row: 📅 + backticked codes for the durable tiers this run was promoted to
  // (D=daily, W=weekly, M=monthly), e.g. 📅`DWM` on a 1st-of-month Sunday. Plain 2hourly → no marker.
  const TIER_CODE: Record<string, string> = { daily: "D", weekly: "W", monthly: "M" };
  const codes = tiers.filter((t) => t !== "2hourly").map((t) => TIER_CODE[t] ?? "").join("");
  const marker = codes ? `📅\`${codes}\`` : "";

  console.log(`✓ Backup complete: ${filename} (${Math.floor(size / 1024 / 1024)} MB) → tiers: ${tiers.join(" ")}`);
  await bestEffort("slack ok tick", () => slackDailyRecord(true, label, marker, origin, now));
  await bestEffort("runlog ok", () =>
    appendRun({
      ts: runTsIso,
      ok: true,
      tiers: tiers as BackupTier[],
      bytes: size,
      key: firstKey,
      sha256,
      counts: dumpCounts,
      durationMs: Date.now() - SCRIPT_START_MS,
    }),
  );

  // Dead-man's-switch ping (success only) — its absence is the staleness signal.
  if (cfg.credentials.heartbeatUrl) {
    const heartbeatUrl = cfg.credentials.heartbeatUrl;
    await bestEffort("heartbeat", () => pingHeartbeat(heartbeatUrl));
  }

  cleanup();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
