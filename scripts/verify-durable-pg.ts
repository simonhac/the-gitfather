import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// Durable-tier verification — guarantees every daily/weekly/monthly object is integrity-tested.
// Runs daily (caller-owned cron); replaces the standalone weekly restore-drill.
//
//   PRIMARY (verify-durable.fresh): on first sight, hash-check every durable object against the
//     SHA-256 recorded at backup time (proves each server-side copy is byte-intact), AND full
//     pg_restore the freshest daily object (proves the freshest dump restores — the "0 errors" leg).
//   SECONDARY (verify-durable.aged): full pg_restore the newest weekly/monthly object ≥ verify-durable.retest-days
//     old not yet restore-verified (the aged-copy proof, just inside the 14-day WORM window).
//
// Net: weekly/monthly are validated twice (hash on write + restore at ~2 weeks), daily once. State
// lives in the verifications log (joined in memory via logStore), so a missed cron self-corrects.
//
// Usage:  PROFILE=profiles/example.yaml npx tsx scripts/verify-durable-pg.ts
// Env mirrors the drill (R2 creds, DRILL_DATABASE_URL, PG_LIVE_DATABASE_URL, AGE_IDENTITY for .age),
// plus verify-durable.fresh / verify-durable.aged / verify-durable.retest-days / verify-durable.max-restores.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVerifyDurableConfig } from "./lib/config.js";
import { capture, commandExists } from "./lib/proc.js";
import { stampToEpochMs } from "./lib/schedule.js";
import { loadLog, stampFromKey, type LogStore } from "./lib/logStore.js";
import { drillObject, drillCoreFromProfile, extForEncryption, stampToIso, type DrillGate } from "./restore-drill-pg.js";
import { appendVerify } from "./runlog.js";
import { slackOneoff, alertWebhook } from "./lib/slack.js";
import type { BackupTier, LogVerification } from "./lib/backupTypes.js";

function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

interface DurableObj {
  tier: BackupTier;
  name: string; // object filename
  key: string; // tier/name (under backup-prefix)
  stamp: string; // compact dump stamp YYYYMMDDTHHMMSSZ
  ageMs: number;
}

const byStampDesc = (a: DurableObj, b: DurableObj): number => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0);

/** Most recent passing RESTORE drill's per-table counts — the drift baseline (best-effort). */
function priorCountsFrom(log: LogStore): Record<string, number> | null {
  const prior = log.verifications
    .filter((v) => v.ok && v.counts && v.kind !== "hash")
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
  return prior?.counts ?? null;
}

async function main(): Promise<void> {
  const cfg = loadVerifyDurableConfig();
  const core = drillCoreFromProfile(cfg);
  const backupPrefix = core.backupPrefix;
  const r2Bucket = core.r2Bucket;
  const fileBasename = cfg.name!;
  const r2Account = cfg.credentials.r2.accountId!;
  const r2Key = cfg.credentials.r2.accessKeyId!;
  const r2Secret = cfg.credentials.r2.secretAccessKey!;

  const tmp = mkdtempSync(join(tmpdir(), "pg-durable-"));
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

  let failures = 0;
  const page = async (msg: string): Promise<void> => {
    process.stderr.write(`ERROR: ${msg}\n`);
    failures++;
    await slackOneoff(`🔴 PG durable-verify FAILED (${fileBasename}): ${msg}`, true).catch(() => {});
    await alertWebhook(`🔴 PG durable-verify FAILED (${fileBasename}): ${msg}`).catch(() => {});
  };
  const fatal = async (msg: string): Promise<never> => {
    await page(msg);
    cleanup();
    process.exit(1);
  };

  if (!commandExists("rclone")) await fatal("rclone not found");

  process.env.RCLONE_CONFIG_R2_TYPE = "s3";
  process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
  process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = r2Key;
  process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = r2Secret;
  process.env.RCLONE_CONFIG_R2_ENDPOINT = `https://${r2Account}.r2.cloudflarestorage.com`;

  let canRestore = true;
  if (!commandExists("pg_restore") || !commandExists("psql")) {
    canRestore = false;
    if (cfg.verifyDurable.fresh || cfg.verifyDurable.aged) {
      process.stderr.write("warning: pg_restore/psql not found — restore legs skipped (hash leg still runs)\n");
    }
  }

  const ext = extForEncryption(cfg.encryption);
  let log: LogStore;
  try {
    log = loadLog();
  } catch (e) {
    process.stderr.write(`could not load the run-log: ${(e as Error).message}\n`);
    await page("could not load the run-log from R2");
    cleanup();
    process.exit(1);
  }
  const priorCounts = core.maxRowDrop > 0 ? priorCountsFrom(log) : null;
  const nowMs = Date.now();
  const retestMs = cfg.verifyDurable.retestDays * 86_400_000;

  // ── Enumerate durable objects ──────────────────────────────────────────────
  const all: DurableObj[] = [];
  for (const tier of ["daily", "weekly", "monthly"] as BackupTier[]) {
    const lsr = capture("rclone", ["lsf", "--files-only", `r2:${r2Bucket}/${backupPrefix}/${tier}/`, "--s3-no-check-bucket"]);
    for (const name of lsr.out.split("\n").map((s) => s.trim()).filter(Boolean).filter((o) => o.endsWith(`.${ext}`))) {
      const stamp = stampFromKey(name);
      if (!stamp) continue;
      const epoch = stampToEpochMs(stamp);
      if (Number.isNaN(epoch)) continue;
      all.push({ tier, name, key: `${tier}/${name}`, stamp, ageMs: nowMs - epoch });
    }
  }
  console.log(`Durable objects: ${all.length} (daily/weekly/monthly under ${backupPrefix})`);

  // ── Verification state per object (join by key, falling back to legacy stamp+tier) ─────────
  const verifsFor = (o: DurableObj): LogVerification[] => {
    const byKey = log.verifyByKey.get(o.key) ?? [];
    const byStamp = (log.verifyByStamp.get(o.stamp) ?? []).filter((v) => !v.key && (v.tier == null || v.tier === o.tier));
    return [...byKey, ...byStamp];
  };
  const everVerifiedOk = (o: DurableObj): boolean => verifsFor(o).some((v) => v.ok);
  const restoreVerifiedOk = (o: DurableObj): boolean => verifsFor(o).some((v) => v.ok && v.kind !== "hash");

  let restoresLeft = cfg.verifyDurable.maxRestores;

  const recordRestore = async (o: DurableObj, gate: DrillGate): Promise<void> => {
    restoresLeft--;
    console.log(`Restore-verifying ${o.key} (gate=${gate}) …`);
    const res = await drillObject({ key: o.key, tier: o.tier, gate, cfg: core, tmp, priorCounts });
    appendVerify({
      ts: isoSeconds(new Date()),
      verifiedTs: stampToIso(o.key) ?? "",
      ok: res.ok,
      ratio: res.ratio,
      tier: o.tier,
      key: o.key,
      kind: "restore",
      counts: res.counts,
      reason: res.reason,
    });
    if (res.ok) console.log(`✓ restore-verified ${o.key}`);
    else await page(`restore of ${o.key} failed — ${res.reason}`);
  };

  const recordHash = async (o: DurableObj): Promise<void> => {
    // --download: R2/S3 doesn't serve SHA-256 natively, so rclone streams the object and hashes it
    // locally (egress is free). This also surfaces any R2-level read corruption.
    const remote = capture("rclone", ["hashsum", "sha256", "--download", `r2:${r2Bucket}/${backupPrefix}/${o.key}`, "--s3-no-check-bucket"]);
    const got = remote.ok ? (remote.out.trim().split(/\s+/)[0]?.toLowerCase() ?? "") : "";
    const record = (ok: boolean, reason: string | null): void =>
      appendVerify({ ts: isoSeconds(new Date()), verifiedTs: stampToIso(o.key) ?? "", ok, ratio: null, tier: o.tier, key: o.key, kind: "hash", reason });

    if (!got) {
      record(false, "could not read R2 sha256");
      await page(`hash-check of ${o.key} — could not read R2 sha256`);
      return;
    }
    const expected = log.runByStamp.get(o.stamp)?.sha256?.toLowerCase() ?? null;
    if (expected) {
      const ok = got === expected;
      record(ok, ok ? null : `sha256 mismatch (R2 ${got.slice(0, 12)}… vs recorded ${expected.slice(0, 12)}…)`);
      if (ok) console.log(`✓ hash-verified ${o.key}`);
      else await page(`hash mismatch ${o.key} (R2 ${got.slice(0, 12)}… vs recorded ${expected.slice(0, 12)}…)`);
      return;
    }
    // No recorded baseline (run predates integrity.checksum). Fall back to the live 2hourly copy if present.
    const twoH = capture("rclone", ["hashsum", "sha256", "--download", `r2:${r2Bucket}/${backupPrefix}/2hourly/${o.name}`, "--s3-no-check-bucket"]);
    const baseline = twoH.ok ? (twoH.out.trim().split(/\s+/)[0]?.toLowerCase() ?? "") : "";
    if (baseline) {
      const ok = got === baseline;
      record(ok, ok ? "matched 2hourly copy (no recorded baseline)" : "differs from 2hourly copy");
      if (ok) console.log(`✓ hash-verified ${o.key} (vs 2hourly copy)`);
      else await page(`hash mismatch ${o.key} vs its 2hourly copy`);
      return;
    }
    record(true, "no sha256 baseline (pre-sha256 run); object present + listable");
    console.log(`• ${o.key}: no sha256 baseline — recorded a hash note (restore leg still covers it)`);
  };

  // ── PRIMARY: hash-check unverified objects + restore the freshest daily ─────────────────────
  if (cfg.verifyDurable.fresh) {
    const hashDue = all.filter((o) => !everVerifiedOk(o));
    console.log(`Primary hash-check: ${hashDue.length} object(s) due`);
    for (const o of hashDue) await recordHash(o);

    if (canRestore && restoresLeft > 0) {
      const dailyTarget = all
        .filter((o) => o.tier === "daily" && o.ageMs < retestMs && !restoreVerifiedOk(o))
        .sort(byStampDesc)[0];
      if (dailyTarget) await recordRestore(dailyTarget, "live-ratio");
      else console.log("Primary restore: no fresh daily object due");
    }
  }

  // ── SECONDARY: restore the newest aged weekly/monthly not yet restore-verified ──────────────
  if (cfg.verifyDurable.aged && canRestore) {
    const agedDue = all
      .filter((o) => (o.tier === "weekly" || o.tier === "monthly") && o.ageMs >= retestMs && !restoreVerifiedOk(o))
      .sort(byStampDesc);
    console.log(`Secondary restore: ${agedDue.length} aged weekly/monthly due, ${restoresLeft} restore slot(s) left`);
    for (const o of agedDue) {
      if (restoresLeft <= 0) {
        console.log(`Secondary restore: hit max-restores — ${agedDue.length - cfg.verifyDurable.maxRestores} deferred to the next run`);
        break;
      }
      await recordRestore(o, "nonempty");
    }
  }

  cleanup();
  if (failures > 0) {
    process.stderr.write(`durable-verify: ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log("✓ durable-verify complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
