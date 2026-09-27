import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// Off-site, provider-independent Postgres backup → Cloudflare R2, with GFS tiering.
//
// Dumps with `pg_dump -Fc` (custom format), optionally encrypts, and uploads to R2 via the S3 API
// (rclone). Each run writes one object to the intraday/ tier and then *promotes* (server-side R2→R2
// copy — no re-dump, no re-upload) that same object into daily/weekly/monthly when the run lands on
// the configured anchor. Retention is enforced by R2 lifecycle rules + bucket locks per prefix (set
// out-of-band; see docs/r2-setup.md), not by this script. Built for GitHub Actions but runnable locally.
//
// Slack: nothing from here. The run leaves an OUTCOME record in R2 as it exits (lib/outcomeRecorder.ts)
// and the scheduler Worker turns it into the day's row — a ✅/❌ + HH:MM tick per slot run — plus, on
// failure, a loud, mentioning threaded alert. The job holds no Slack token.
//
// Usage:
//   PROFILE=profiles/example.yaml npx tsx scripts/backup-pg-to-r2.ts
//
// Required env (credentials — from GitHub secrets, NOT the profile):
//   PG_BACKUP_DATABASE_URL   postgres://USER:PW@HOST:5432/DB?sslmode=require
//                            ^ if your provider has a connection pooler, prefer its SESSION pooler.
//   R2_ACCOUNT_ID            endpoint = https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
//   R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
// Optional env: HEARTBEAT_URL / AGE_RECIPIENT / FORCE_TIERS.
// All other config comes from $PROFILE (the YAML profile).
// ─────────────────────────────────────────────────────────────────────────────

import { statSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupSchema, reportConfigError } from "./lib/config.js";
import { buildRawProfile } from "./lib/profile.js";
import { pgConn } from "./lib/pgconn.js";
import { verifyDumpFile } from "./restore-drill-pg.js";
import { run, runToFile, commandExists, bestEffort, sha256File, capture, stderrTee } from "./lib/proc.js";
import { classifyPgFailure, isConnectionLevel } from "./lib/pg-classify.js";
import type { PgFailureCode } from "./lib/pg-classify.js";
import { computeTiers, INTRADAY_TIER, normalizeTier, runOrigin } from "./lib/schedule.js";
import { appendRun, appendVerify } from "./runlog.js";
import { pingHeartbeat } from "./lib/heartbeat.js";
import { publishWatchdogConfig } from "./lib/watchdogPublish.js";
import { startOutcome } from "./lib/outcomeRecorder.js";
import { TIER_META, type BackupTier } from "./lib/backupTypes.js";

// Captured at module load (≈ process start) so both recordConfigFailure() and main() can stamp the
// run-log with the whole-script wall time — see the appendRun({ durationMs }) call sites below.
const SCRIPT_START_MS = Date.now();

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * TABLE / TABLE DATA entries in a `pg_restore -l` listing — the "is there actually anything in
 * here" half of the structural check. Zero means a schema-only or empty dump that is nonetheless a
 * perfectly parseable archive above the size floor, which is precisely the case neither
 * `dump.min-bytes` nor `pg_restore -l`'s exit code catches.
 *
 * Exported so it is testable without a database: this check now runs for EVERY encryption mode
 * (it reads the plaintext, before encryption), so it guards every backup rather than only the
 * unencrypted ones it was originally written for.
 */
export function countTocTableEntries(toc: string): number {
  return toc.split("\n").filter((l) => /\bTABLE( DATA)?\b/.test(l)).length;
}

/** UTC `date +%Y%m%dT%H%M%SZ`. */
function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/**
 * Best-effort run-log ❌ when config validation fails BEFORE the normal flow could record anything — so
 * the dashboard and the watchdog see a failed run, not a missing one (indistinguishable from a dropped
 * scheduler tick). The Slack row's ❌ comes from the outcome record instead (reportConfigError pages
 * `config_invalid` into it). `cfg` is unavailable, so it reads raw process.env and no-ops unless it has
 * everything needed to reach R2 (true for the #165 case, where only the DB URL was empty). NEVER echoes
 * a config value — the message is generic (secret-safe).
 */
async function recordConfigFailure(): Promise<void> {
  // The profile `name` comes from the YAML, read RAW — the profile may itself be what failed validation
  // (a typo'd key, an out-of-range number), and appendRun keys on the raw name the same way. R2 creds are env.
  let basename: unknown;
  try {
    basename = buildRawProfile().name;
  } catch {
    return; // an unreadable $PROFILE: no name to file the run under
  }
  const acct = process.env.R2_ACCOUNT_ID,
    bkt = process.env.R2_BUCKET;
  const key = process.env.R2_ACCESS_KEY_ID,
    sec = process.env.R2_SECRET_ACCESS_KEY;
  if (typeof basename !== "string" || !basename || !acct || !bkt || !key || !sec) return; // can't reach the run-log
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
  const msg = "config validation failed"; // GENERIC — never include the offending value (secret-safe)
  await bestEffort("runlog config-fail", () =>
    appendRun({ ts: runTsIso, ok: false, tiers: [], error: msg, durationMs: Date.now() - SCRIPT_START_MS }),
  );
}

async function main(): Promise<void> {
  // FIRST, before config is even read: from here on, every way out of this process — a config
  // failure included — leaves an outcome record for the scheduler to announce.
  const rec = startOutcome("backup");
  // Row marker: 🖐️ for hand-kicked runs, 🩹 for a staleness self-heal catch-up, none for cron. Env-only,
  // so it is known even when the profile is not. See runOrigin.
  rec.setOrigin(runOrigin(process.env.GITHUB_EVENT_NAME, process.env.BACKUP_TRIGGER));

  // Validate + type all config up front (zod). On any missing/malformed var, append a best-effort ❌ to
  // the run-log, print the aggregated report (names only — it also pages `config_invalid` into the
  // outcome record, so today's row shows ❌, not ⬜), then exit 1 — before any dump/upload. See lib/config.ts.
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
  rec.setName(fileBasename);

  const now = new Date();
  const stamp = utcStamp(now);
  const runTsIso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` +
    `T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const endpoint = `https://${r2Account}.r2.cloudflarestorage.com`;

  // rclone S3 remote configured purely from env (no rclone.conf on disk). Set early so fail()'s run-log
  // write and the outcome record can reach R2 even if a failure happens before the upload.
  process.env.RCLONE_CONFIG_R2_TYPE = "s3";
  process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
  process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = r2Key;
  process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = r2Secret;
  process.env.RCLONE_CONFIG_R2_ENDPOINT = endpoint;

  // Publish the staleness watchdog's view of this profile to the bucket, every run, before the dump —
  // the Cloudflare Worker reads it from there (lib/watchdogConfig.ts). Config flows GitHub → Cloudflare,
  // never the reverse, and a profile edit lands with the next run. Best-effort: never blocks the dump.
  await bestEffort("publish watchdog config", () => publishWatchdogConfig(cfg, now));

  // Object extension per encryption mode. Unknown mode is a plain config error (the recorder pages it as exit_1).
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

  // On failure: a page in this run's outcome record — the scheduler turns it into the row's ❌ and a
  // loud, mentioning alert threaded under it — then the run-log record, then exit (the recorder writes
  // the outcome on the way out, after the run-log append).
  // `errorCode` is the machine-readable twin of `msg` (see lib/pg-classify.ts). It rides into the
  // PRIVATE run-log so the staleness watchdog can quote the cause in its page without re-deriving
  // it from prose, and into the outcome as the alert's code; build-dashboard.ts maps Log*→Public*
  // explicitly, so it never reaches the public dashboard. null for the failures that aren't a
  // database failure at all (missing binary, config) — those page as `backup_failed`.
  const fail = async (msg: string, errorCode: PgFailureCode | null = null): Promise<never> => {
    process.stderr.write(`ERROR: ${msg}\n`);
    rec.alert("page", errorCode ?? "backup_failed", msg);
    await bestEffort("runlog fail", () =>
      appendRun({ ts: runTsIso, ok: false, tiers: [], error: msg, errorCode, durationMs: Date.now() - SCRIPT_START_MS }),
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
      // This probe is the first thing to touch the database, so it is the first thing to see a
      // dead credential — and it used to bury that under "could not count", costing 16 hours of
      // pages that named the wrong thing. If it failed because it could never open a session,
      // the dump is already doomed: fail now, with the real reason. Anything else (a missing
      // table, a privilege, an unrecognised error) keeps the tolerant warn-and-continue, because
      // only pg_dump can actually settle it.
      const probe = classifyPgFailure(r.stderr, `could not count public.${sentinelTable}`);
      if (isConnectionLevel(probe.code)) await fail(probe.message, probe.code);
      process.stderr.write(`warning: could not count public.${sentinelTable} at dump time — the drill will fall back to the live estimate\n`);
    }
  }

  if (encryption === "aes-gcm") {
    await fail("ENCRYPTION=aes-gcm not implemented yet (encryption is a planned follow-up)");
  }

  /**
   * Everything we can prove about the dump while it is still plaintext in our hands — which is
   * everything worth proving, and none of it needs a decrypt key.
   *
   * Records a `pre-encrypt` verification, NOT a `restore` one. It cannot be a `restore`: the object
   * it proves is the dump, which has not been encrypted or uploaded yet, so it says nothing about
   * whether the ciphertext in the bucket opens. Recording it as `restore` would light every cell on
   * the dashboard while nothing had been restore-verified at all.
   */
  const verifyPlaintext = async (plainPath: string): Promise<void> => {
    // `pg_restore -l` lists the TOC (cheap — header and table of contents, not the data); a corrupt
    // or truncated archive can't be listed, and a real data dump has ≥1 TABLE/TABLE DATA entry.
    // This catches a >dump.min-bytes-but-corrupt dump BEFORE it is reported as a successful backup.
    if (cfg.integrity.checkStructure) {
      if (!commandExists("pg_restore")) {
        process.stderr.write("warning: integrity.check-structure is on but pg_restore not found — skipping TOC validation\n");
      } else {
        const toc = capture("pg_restore", ["-l", plainPath]);
        if (!toc.ok) await fail("dump is not a parseable pg_dump archive (pg_restore -l failed)");
        const tableEntries = countTocTableEntries(toc.out);
        if (tableEntries === 0) await fail("dump TOC has no TABLE entries — suspect an empty or schema-only dump");
        console.log(`Structural check: ${tableEntries} TABLE/TABLE DATA TOC entries — archive is parseable`);
      }
    }

    if (!cfg.integrity.verifyBeforeEncrypt) return;

    // Timed separately from the run as a whole: "restore every dump rather than only the promoted
    // ones" is a cost decision, and revisiting it needs a number rather than an impression.
    const startedAt = Date.now();
    console.log("Pre-encrypt restore drill: restoring this dump into the throwaway target …");
    const res = await verifyDumpFile({
      dumpPath: plainPath,
      gate: "live-ratio",
      cfg: {
        // The database we just dumped IS the live reference — no separate PG_LIVE_DATABASE_URL to
        // wire, and no window for the two to drift apart.
        liveDatabaseUrl: dbUrl,
        drillDatabaseUrl: cfg.credentials.drillDatabaseUrl!,
        rowCountTable: cfg.drill.rowCountTable!,
        presentTables: cfg.drill.presentTables,
        nonemptyTables: cfg.drill.nonemptyTables,
        minRowRatio: cfg.drill.minRowRatio,
        maxRowRatio: cfg.drill.maxRowRatio,
        maxRowDrop: cfg.drill.maxRowDrop,
      },
      tmp,
      // The count taken from the live table moments ago, so the ratio compares like with like.
      refCount: dumpCounts?.[cfg.drill.rowCountTable!] ?? null,
    });
    const tookMs = Date.now() - startedAt;
    console.log(`Pre-encrypt restore drill: ${res.ok ? "PASSED" : "FAILED"} in ${Math.round(tookMs / 1000)}s`);

    await bestEffort("append pre-encrypt verification", () =>
      Promise.resolve(
        appendVerify({
          ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          verifiedTs: runTsIso,
          ok: res.ok,
          ratio: res.ratio,
          // Keyed to the intraday object this dump becomes. Without a key AND a tier, the record
          // has neither — and verify-durable's stamp-join matches any keyless, tierless record to
          // EVERY durable object sharing the stamp, which made all of them look already-verified
          // and emptied the hash leg. The hash leg is now kind-aware so this cannot recur, but a
          // record that speaks for objects it knows nothing about is a trap for the next reader.
          key: `${INTRADAY_TIER}/${filename}`,
          tier: INTRADAY_TIER,
          kind: "pre-encrypt",
          by: "ci",
          counts: res.counts,
          reason: res.reason,
          durationMs: tookMs,
        }),
      ),
    );

    // Refuse to upload a dump that does not restore. min-bytes and the TOC check both pass on one
    // that is structurally fine and semantically empty; this is the gate that does not.
    if (!res.ok) await fail(`pre-encrypt restore drill failed — ${res.reason}`);
  };

  // ── Dump to PLAINTEXT first, always ────────────────────────────────────────
  // This used to be `pg_dump | age` straight to `out`, so under age the plaintext never existed as
  // a file — and every check that needs to read a dump therefore had to happen AFTER encryption,
  // which meant downloading, decrypting, and holding AGE_IDENTITY in CI to do it. The plaintext is
  // right here; checking it here costs no key at all. See CB-303.
  //
  // The cost is real and deliberate: the dump is briefly at rest on the runner. Keep `plain` on a
  // RAM disk (the caller sets TMPDIR) and shred it the moment it is encrypted — see below.
  const plain = encryption === "none" ? out : join(tmp, `${fileBasename}-${stamp}.dump`);
  console.log(`Dumping Postgres → ${plain} ...`);
  {
    // Tee pg_dump's stderr: it still streams to the job log unchanged, but we keep a copy so the
    // alert can name the cause instead of saying "pg_dump failed" and making someone open Actions.
    const tee = stderrTee();
    const code = await runToFile("pg_dump", [...dumpFlags, db.safeUrl], plain, db.env, { onStderr: tee.onChunk });
    if (code !== 0) {
      const f = classifyPgFailure(tee.text());
      await fail(f.message, f.code);
    }
  }

  const plainSize = statSync(plain).size;
  console.log(`Dump size: ${Math.floor(plainSize / 1024 / 1024)} MB (${plainSize} bytes, plaintext)`);
  if (plainSize < minBytes) await fail(`dump suspiciously small (${plainSize} < ${minBytes}) — not uploading`);

  // ── Structural + restore validation of the PLAINTEXT, before it is encrypted ───────────────
  await verifyPlaintext(plain);

  // ── Encrypt ────────────────────────────────────────────────────────────────
  if (encryption === "age") {
    if (!commandExists("age")) await fail("ENCRYPTION=age but 'age' not found");
    // Presence is already enforced by the schema (age ⇒ AGE_RECIPIENT); guard kept as defence-in-depth.
    const recipient = cfg.credentials.age.recipient;
    if (!recipient) await fail("ENCRYPTION=age requires AGE_RECIPIENT");
    // Belt-and-braces beside the schema's own check: nothing downstream can read a recipient back
    // out of an age header, so if this is wrong we produce objects nobody can open and find out
    // only at the next decrypt drill. Fail before writing any of them.
    const pinned = cfg.expectRecipient;
    if (pinned && pinned !== recipient) {
      await fail(`AGE_RECIPIENT does not match the profile's pinned expect-recipient — refusing to encrypt`);
    }
    console.log(`Encrypting → ${out} (recipient ${recipient!.slice(0, 16)}…${pinned ? ", matches the pinned recipient" : ""})`);
    const code = await runToFile("age", ["-r", recipient!, plain], out);
    if (code !== 0) await fail("age encrypt failed");
    // The plaintext has done its job. Remove it BEFORE the upload, so it is gone for the longest
    // part of the run rather than only when the tmp dir is torn down.
    rmSync(plain, { force: true });
  }

  const size = statSync(out).size;
  if (size !== plainSize) console.log(`Encrypted size: ${Math.floor(size / 1024 / 1024)} MB (${size} bytes)`);

  // ── Content hash (#1): SHA-256 of the EXACT bytes we upload (ciphertext for age) ───────────
  // Streamed (never buffers the dump on the heap). Best-effort — a hash hiccup must not fail an
  // otherwise-good backup. Recorded in the run-log as the durable hash-verify baseline.
  let sha256: string | null = null;
  if (cfg.integrity.checksum) {
    sha256 = (await bestEffort("sha256", () => sha256File(out))) ?? null;
    if (sha256) console.log(`SHA-256: ${sha256}`);
  }

  // ── Which tiers does this run belong to? ───────────────────────────────────
  // Always intraday; the anchor-hour run is also daily, +weekly on Sun, +monthly on the 1st (UTC).
  // FORCE_TIERS is a per-run override (manual/self-heal dispatch), so it stays an env read, not profile config.
  // The legacy "2hourly" is accepted as a spelling of "intraday"; anything else unknown is refused
  // rather than becoming an R2 prefix nobody expires.
  const forceTiers = (process.env.FORCE_TIERS ?? "").split(/\s+/).filter(Boolean).map(normalizeTier) as BackupTier[];
  const unknownTiers = forceTiers.filter((t) => !(t in TIER_META));
  if (unknownTiers.length) await fail(`FORCE_TIERS has unknown tier(s): ${unknownTiers.join(" ")} (use ${Object.keys(TIER_META).join(" ")})`);
  const tiers = computeTiers(now, anchorHour, forceTiers);
  console.log(`Tiers for this run: ${tiers.join(" ")}`);

  // Upload once to the first tier (always intraday), then server-side copy to the rest. Single-PUT
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

  console.log(`✓ Backup complete: ${filename} (${Math.floor(size / 1024 / 1024)} MB) → tiers: ${tiers.join(" ")}`);
  // The row's ✅ tick. The scheduler derives the tick's HH:MM from the record's startedAt and the 📅
  // durable-tier marker from `tiers`, so neither is computed here.
  rec.summary({ kind: "backup", tiers, bytes: size });
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
    await bestEffort("heartbeat", () => pingHeartbeat(heartbeatUrl, "heartbeat"));
  }

  cleanup();
}

/**
 * Only run when invoked directly. Without this, merely IMPORTING this module took a backup — or,
 * in a test, validated config against an empty environment and called process.exit(1). That is
 * why nothing in here had ever been unit-tested: it could not be imported. The sibling scripts
 * (restore-drill-pg.ts, drill-object.ts) already guard this way.
 */
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
