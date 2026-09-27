import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// Durable-tier verification — guarantees every daily/weekly/monthly object is integrity-tested.
// Runs daily (caller-owned cron); replaces the standalone weekly restore-drill.
//
//   PRIMARY (verify-durable.fresh): on first sight, hash-check every durable object against the
//     SHA-256 recorded at backup time (proves each server-side copy is byte-intact), AND full
//     pg_restore the freshest daily object (proves the freshest dump restores — the "0 errors" leg).
//   ROTATION (verify-durable.rehash-per-run): ALSO re-hash the N least-recently-hashed objects,
//     every run. A first-sight hash alone was only sufficient while the aged leg came back later;
//     a claim made once is not an ongoing one. rehash-max-age-days pages if the sweep falls behind.
//   SECONDARY (verify-durable.aged): full pg_restore the newest weekly/monthly object ≥ verify-durable.retest-days
//     old not yet restore-verified (the aged-copy proof, just inside the 14-day WORM window).
//
// Net: weekly/monthly are validated twice (hash on write + restore at ~2 weeks) and re-hashed each
// sweep thereafter; daily once. State lives in the verifications log (joined in memory via
// logStore), so a missed cron self-corrects.
//
//   KEYLESS (verify-durable.keyless): no AGE_IDENTITY, no database, no restores — the hash legs
//     alone. For a deployment that keeps the identity OFFLINE and proves restorability at backup
//     time (integrity.verify-before-encrypt) plus a periodic human drill (drill-object.ts). It is
//     DECLARED, never inferred from a missing key: a profile that meant to decrypt and lost its
//     identity must fail loudly, not quietly become a hash-only check that still reports success.
//     drill-max-age-days warns when that human drill goes stale.
//
// Usage:  PROFILE=profiles/example.yaml npx tsx scripts/verify-durable-pg.ts
// Env mirrors the drill (R2 creds, DRILL_DATABASE_URL, PG_LIVE_DATABASE_URL, AGE_IDENTITY for .age
// — none of the last three under keyless), plus the verify-durable.* keys above.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVerifyDurableConfig, retentionFromConfig } from "./lib/config.js";
import { capture, commandExists } from "./lib/proc.js";
import { stampToEpochMs } from "./lib/schedule.js";
import { loadLog, stampFromKey, type LogStore } from "./lib/logStore.js";
import { DURABLE_TIERS, expectedDurableKeys } from "./lib/durableCensus.js";
import { verifyHeartbeatVerdict } from "./lib/verifyHeartbeat.js";
import { pingHeartbeat } from "./lib/heartbeat.js";
import { publishJobProof } from "./lib/jobProofPublish.js";
import { credentialVerdicts, needsAttention } from "./lib/credentialAge.js";
import { drillObject, drillCoreFromProfile, isDumpObject, stampToIso, type DrillGate } from "./restore-drill-pg.js";
import { appendVerify } from "./runlog.js";
import { slackOneoff, alertWebhook, failAlertText } from "./lib/slack.js";
import { githubLogUrl } from "./lib/github.js";
import {
  hasRestoredCounts,
  oldestHashAgeDays,
  provesStoredObjectRestores,
  selectRehashTargets,
  type BackupTier,
  type LogVerification,
} from "./lib/backupTypes.js";

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
    .filter((v) => v.ok && v.counts && hasRestoredCounts(v.kind))
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
    await slackOneoff(failAlertText("durable-verify FAILED", msg, await githubLogUrl()), true).catch(() => {});
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
  if (cfg.verifyDurable.keyless) {
    // Say it on stdout as a normal fact, not on stderr as a warning. This is a configured posture,
    // not a degraded run: the identity is deliberately offline, restorability is proved at backup
    // time by integrity.verify-before-encrypt, and a human drill covers decryptability. An absence
    // that explains itself is the difference between "this is fine" and "why is nothing restoring".
    canRestore = false;
    console.log(
      "Restore legs DISABLED: verify-durable.keyless is on — this job holds no age identity by design. " +
        "Hash checks prove the stored bytes are unchanged; that they RESTORE was proved before they were " +
        "encrypted, and that they DECRYPT is proved by the periodic manual drill.",
    );
  } else if (!commandExists("pg_restore") || !commandExists("psql")) {
    canRestore = false;
    if (cfg.verifyDurable.fresh || cfg.verifyDurable.aged) {
      process.stderr.write("warning: pg_restore/psql not found — restore legs skipped (hash leg still runs)\n");
    }
  }

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
  // isDumpObject, NOT the currently configured extension: a bucket holds both generations for a
  // whole retention window after `encryption:` changes, and every one of them is ours to verify.
  const all: DurableObj[] = [];
  // A failed listing used to be silently indistinguishable from an empty tier, which makes the
  // census floor below meaningless (it can only catch omissions it knows to expect) and would let
  // an incomplete enumeration pass as a clean verify.
  let listingOk = true;
  for (const tier of DURABLE_TIERS) {
    const lsr = capture("rclone", ["lsf", "--files-only", `r2:${r2Bucket}/${backupPrefix}/${tier}/`, "--s3-no-check-bucket"]);
    if (!lsr.ok) {
      listingOk = false;
      await page(`could not list ${backupPrefix}/${tier}/ — enumeration incomplete, census floor unreliable`);
    }
    for (const name of lsr.out.split("\n").map((s) => s.trim()).filter(Boolean).filter(isDumpObject)) {
      const stamp = stampFromKey(name);
      if (!stamp) continue;
      const epoch = stampToEpochMs(stamp);
      if (Number.isNaN(epoch)) continue;
      all.push({ tier, name, key: `${tier}/${name}`, stamp, ageMs: nowMs - epoch });
    }
  }

  // ── Census floor ───────────────────────────────────────────────────────────
  // Everything below works off `all`, which is a FILTERED listing — so on its own it cannot tell
  // "nothing is due" apart from "I could not see it", and it has been wrong that way before. The
  // run-log is an independent record of what was promoted and is still inside its retention
  // window; anything it names that the listing missed is either a lifecycle rule deleting early or
  // this enumeration going blind again. Both are backup failures, so page rather than log.
  const expected = expectedDurableKeys(log.runs, retentionFromConfig(cfg.retention), nowMs);
  const found = new Set(all.map((o) => o.key));
  const missing = expected.filter((k) => !found.has(k));
  console.log(
    `Durable objects: ${all.length} (daily/weekly/monthly under ${backupPrefix}); run-log expects at least ${expected.length}`,
  );
  if (missing.length) {
    const shown = missing.slice(0, 5).join(", ");
    await page(
      `durable census short by ${missing.length} of ${expected.length}: ` +
        `${shown}${missing.length > 5 ? `, +${missing.length - 5} more` : ""} — ` +
        `present in the run-log, absent from the ${backupPrefix} listing`,
    );
  }

  // ── Verification state per object (join by key, falling back to legacy stamp+tier) ─────────
  const verifsFor = (o: DurableObj): LogVerification[] => {
    const byKey = log.verifyByKey.get(o.key) ?? [];
    const byStamp = (log.verifyByStamp.get(o.stamp) ?? []).filter((v) => !v.key && (v.tier == null || v.tier === o.tier));
    return [...byKey, ...byStamp];
  };
  // There is deliberately no "has any passing verification" helper any more. That question is what
  // the hash leg used to ask, and a `pre-encrypt` record answered it for every object sharing a
  // dump stamp — so the leg emptied itself. Each caller below asks the narrower question it means.
  /** Records that actually hashed THIS object's stored bytes — the only thing a hash leg may count. */
  const hashVerifs = (o: DurableObj): LogVerification[] => verifsFor(o).filter((v) => v.ok && v.kind === "hash");
  /** ms of the newest passing hash for this object, or null. Drives the re-hash rotation. */
  const lastHashedMs = (o: DurableObj): number | null => {
    const times = hashVerifs(o).map((v) => Date.parse(v.ts)).filter((n) => Number.isFinite(n));
    return times.length ? Math.max(...times) : null;
  };
  const restoreVerifiedOk = (o: DurableObj): boolean => verifsFor(o).some((v) => v.ok && provesStoredObjectRestores(v.kind));

  let restoresLeft = cfg.verifyDurable.maxRestores;

  let restoresThisRun = 0;
  let hashesThisRun = 0;
  const hashedThisRun = new Set<string>();

  const recordRestore = async (o: DurableObj, gate: DrillGate): Promise<void> => {
    restoresLeft--;
    console.log(`Restore-verifying ${o.key} (gate=${gate}) …`);
    // For the fresh-daily live-ratio gate, use the sentinel count recorded at DUMP time (matched by stamp)
    // as the reference, so an active table that grew between the dump and this verify can't false-trip the
    // floor. The aged "nonempty" gate takes no ratio. null when the run predates the recorded count → the
    // gate falls back to the live estimate.
    const refCount = gate === "live-ratio" ? (log.runByStamp.get(o.stamp)?.counts?.[core.rowCountTable] ?? null) : null;
    const res = await drillObject({ key: o.key, tier: o.tier, gate, cfg: core, tmp, priorCounts, refCount });
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
    if (res.ok) {
      restoresThisRun++;
      console.log(`✓ restore-verified ${o.key}`);
    }
    else await page(`restore of ${o.key} failed — ${res.reason}`);
  };

  const recordHash = async (o: DurableObj): Promise<void> => {
    // --download: R2/S3 doesn't serve SHA-256 natively, so rclone streams the object and hashes it
    // locally (egress is free). This also surfaces any R2-level read corruption.
    const remote = capture("rclone", ["hashsum", "sha256", "--download", `r2:${r2Bucket}/${backupPrefix}/${o.key}`, "--s3-no-check-bucket"]);
    const got = remote.ok ? (remote.out.trim().split(/\s+/)[0]?.toLowerCase() ?? "") : "";
    const record = (ok: boolean, reason: string | null, compared = true): void => {
      // Count only passes that actually COMPARED bytes. In keyless mode this number is what lets
      // the job publish its proof, so it has to mean "somebody checked something today":
      //   - a FAILED hash must not count — it has already paged, and the proof should stay withheld;
      //   - nor must the legacy "no sha256 baseline" pass below, which records that an object is
      //     present and listable and nothing more. Letting that satisfy the dead-man's switch
      //     would let a corpus of pre-`integrity.checksum` objects keep the heartbeat alive while
      //     no byte comparison had happened at all.
      if (ok && compared) {
        hashesThisRun++;
        hashedThisRun.add(o.key);
      }
      appendVerify({ ts: isoSeconds(new Date()), verifiedTs: stampToIso(o.key) ?? "", ok, ratio: null, tier: o.tier, key: o.key, kind: "hash", reason });
    };

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
    record(true, "no sha256 baseline (pre-sha256 run); object present + listable", false);
    console.log(`• ${o.key}: no sha256 baseline — recorded a hash note (restore leg still covers it)`);
  };

  // ── PRIMARY: hash-check unverified objects + restore the freshest daily ─────────────────────
  if (cfg.verifyDurable.fresh) {
    // Due for a BASELINE hash = has no passing HASH record. Deliberately not `everVerifiedOk`:
    // a `pre-encrypt` record carries no key and a null tier, so it satisfies the stamp-join for
    // every durable object sharing its dump stamp — which, once the backup started writing them,
    // marked every object "verified" and silently emptied this list entirely.
    const hashDue = all.filter((o) => hashVerifs(o).length === 0);
    console.log(`Primary hash-check: ${hashDue.length} object(s) due a baseline hash`);
    for (const o of hashDue) await recordHash(o);

    // …and re-hash the least-recently-hashed objects, so "the bytes are unchanged" stays a CURRENT
    // claim rather than one made once when the object first appeared. See selectRehashTargets.
    const alreadyHashed = new Set(hashDue.map((o) => o.key));
    const rotation = selectRehashTargets(
      all.filter((o) => !alreadyHashed.has(o.key)).map((o) => ({ key: o.key, lastHashedMs: lastHashedMs(o) })),
      cfg.verifyDurable.rehashPerRun,
    );
    if (rotation.length) {
      console.log(`Re-hash rotation: ${rotation.join(", ")} (least recently hashed of ${all.length})`);
      for (const key of rotation) {
        const o = all.find((x) => x.key === key);
        if (o) await recordHash(o);
      }
    }

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

  // ── Is the re-hash rotation keeping up? ────────────────────────────────────
  // The rotation's own dead-man's switch. Set rehash-per-run to 0, or let the corpus outgrow the
  // budget, and coverage decays with no symptom at all — every run still green, every object
  // quietly going longer unchecked. Measured AFTER this run's work, so today's hashes count.
  if (cfg.verifyDurable.rehashMaxAgeDays > 0 && all.length > 0) {
    const oldestDays = oldestHashAgeDays(
      all.map((o) => ({ key: o.key, lastHashedMs: hashedThisRun.has(o.key) ? nowMs : lastHashedMs(o) })),
      nowMs,
    );
    if (oldestDays !== null && oldestDays > cfg.verifyDurable.rehashMaxAgeDays) {
      const shown = oldestDays === Infinity ? "never hashed" : `${Math.floor(oldestDays)}d`;
      await page(
        `re-hash rotation is behind: the least-recently-hashed durable object was last checked ${shown}, ` +
          `over the ${cfg.verifyDurable.rehashMaxAgeDays}d limit — raise verify-durable.rehash-per-run ` +
          `(currently ${cfg.verifyDurable.rehashPerRun}/run against ${all.length} objects)`,
      );
    } else if (oldestDays !== null && oldestDays !== Infinity) {
      console.log(`Re-hash rotation: oldest last-hash ${Math.floor(oldestDays)}d (limit ${cfg.verifyDurable.rehashMaxAgeDays}d)`);
    }
  }

  // ── Is the MANUAL decrypt drill overdue? ───────────────────────────────────
  // Keyless mode's one irreducible gap: nothing automated can prove the escrowed identity still
  // opens a stored object, so a human runs `drill-object` periodically. That makes "somebody
  // forgot" a real failure mode with, otherwise, no signal whatsoever — the cadence would live
  // only in a doc. A warning rather than a page, matching credential ageing below: a missed drill
  // is not corruption, and a hard page on a human-cadence task is one people learn to ignore.
  if (cfg.verifyDurable.drillMaxAgeDays > 0) {
    const manual = log.verifications
      .filter((v) => v.ok && v.by === "manual" && provesStoredObjectRestores(v.kind))
      .map((v) => Date.parse(v.ts))
      .filter((n) => Number.isFinite(n));
    const newest = manual.length ? Math.max(...manual) : null;
    const ageDays = newest === null ? null : Math.floor((nowMs - newest) / 86_400_000);
    if (ageDays === null || ageDays > cfg.verifyDurable.drillMaxAgeDays) {
      const what = ageDays === null ? "has NEVER been run" : `was ${ageDays}d ago`;
      const msg =
        `manual decrypt drill ${what} (limit ${cfg.verifyDurable.drillMaxAgeDays}d) — ` +
        `nothing else proves the escrowed age identity still opens a stored object. ` +
        `Run: npm run drill-object -- --key <tier>/<object>`;
      process.stderr.write(`${msg}\n`);
      await slackOneoff(`⚠️ *${fileBasename} backups* — ${msg}`, false).catch(() => {});
    } else {
      console.log(`Manual decrypt drill: ${ageDays}d ago (limit ${cfg.verifyDurable.drillMaxAgeDays}d)`);
    }
  }

  // ── Credential age ─────────────────────────────────────────────────────────
  // Hygiene, not integrity, so it never fails the run — an R2 token nobody has rotated cannot
  // corrupt a backup. It rides on this job because this is the daily one that already has the
  // run-log open, and because a credential that silently ages out is exactly the kind of thing
  // that is only ever noticed at the worst moment.
  const creds = credentialVerdicts(log.credentials, cfg.credentialRotation.track, cfg.credentialRotation.maxAgeDays, nowMs);
  for (const v of creds) console.log(`  credential ${v.message}`);
  const stale = needsAttention(creds);
  if (stale.length) {
    const summary = stale.map((v) => v.message).join("; ");
    process.stderr.write(`credential rotation: ${summary}\n`);
    await slackOneoff(`⚠️ *${fileBasename} credential rotation* — ${summary}`, false).catch(() => {});
  }

  cleanup();
  if (failures > 0) {
    process.stderr.write(`durable-verify: ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log("✓ durable-verify complete");

  // ── Dead-man's-switch: a CLEAN verify, not "the job ran" ───────────────────────────────────
  // Guards the failure a backup heartbeat cannot see: dumps that land on schedule but will not
  // restore. Until now that failure was Slack-only, i.e. invisible if Slack broke.
  //
  // Two conditions, and the second is the one that is easy to get wrong:
  //   failures === 0   every hash check, restore gate and the census floor passed.
  //   all.length > 0   the run actually SAW durable objects. An empty listing verifies nothing,
  //                    and "the job exited 0" over nothing is precisely the too-weak signal that
  //                    kept liveone's collector green while every store failed. Note a steady-state
  //                    day where nothing is DUE is still clean — requiring work-done would make the
  //                    heartbeat go quiet on healthy days, which is the opposite of what we want.
  //
  // Credential-rotation warnings deliberately do NOT withhold the ping: they are an advisory note
  // about key age, not a statement about whether these backups restore.
  //
  // The SAME verdict gates two outputs: the job proof (`_health/<name>/durableVerify.json`, always —
  // read by the scheduler's /health/jobs, see lib/jobProof.ts) and the optional push heartbeat.
  // "Nothing was DUE" (healthy) vs "nothing was POSSIBLE" (nobody checked) — see
  // lib/verifyHeartbeat.ts. An earlier version required only failures===0 and a non-empty
  // listing, which pinged on runs that restored nothing at all.
  const verdict = verifyHeartbeatVerdict({
    failures,
    listingOk,
    objectCount: all.length,
    canRestore,
    restoreLegEnabled: cfg.verifyDurable.fresh || cfg.verifyDurable.aged,
    maxRestores: cfg.verifyDurable.maxRestores,
    restoresThisRun,
    // The "nothing was due" case: an object newer than retest-days already carries a successful
    // restore, so restorability IS currently proven even though this run restored nothing.
    recentRestoreOnRecord: all.some((o) => o.ageMs < retestMs && restoreVerifiedOk(o)),
    keyless: cfg.verifyDurable.keyless,
    hashesThisRun,
  });
  if (verdict.allowed) {
    publishJobProof({ bucket: r2Bucket, name: fileBasename, job: "durableVerify" });
    const verifyHeartbeatUrl = cfg.credentials.verifyHeartbeatUrl;
    if (verifyHeartbeatUrl) await pingHeartbeat(verifyHeartbeatUrl, "verify heartbeat");
  } else {
    process.stderr.write(`durable-verify proof withheld: ${verdict.reason}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
