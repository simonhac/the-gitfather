import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// Restore drill — proves the latest off-site R2 dump actually restores. The "0 restore errors" leg
// of 3-2-1-1-0; a backup isn't real until restored.
//
// Pulls the newest object under $backup-prefix from R2, decrypts if needed, pg_restores it into a
// throwaway target, and asserts the restored sentinel-table row count is within tolerance of the
// live count (catches both a truncated dump and a stale/stuck backup). Best-effort Slack alert +
// non-zero exit on failure.
//
// The restore + assertion core is exported as drillObject() so the daily durable-verify job
// (verify-durable-pg.ts) can restore a SPECIFIC durable key, not just the newest 2hourly object.
// Every drill — pass OR fail — now records a verification (gap #5: failed drills were unlogged).
//
// Usage:
//   PROFILE=profiles/example.yaml npx tsx scripts/restore-drill-pg.ts
//
// Required env (credentials — from GitHub secrets, NOT the profile):
//   R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   read access to the bucket
//   DRILL_DATABASE_URL        throwaway Postgres to restore into (e.g. the CI postgres:17 service)
//   PG_LIVE_DATABASE_URL      live DB — read-only, for the expected row count
// Optional env: SLACK_BOT_TOKEN / SLACK_CHANNEL ; AGE_IDENTITY (only if backups are .age). Other config from $PROFILE.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync, statSync, writeFileSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDrillConfig, type Profile } from "./lib/config.js";
import { run, runToFile, capture, captureStderr, commandExists } from "./lib/proc.js";
import { pgConn, withDatabase } from "./lib/pgconn.js";
import { classifyPgRestoreStderr } from "./lib/pgRestore.js";
import { loadLog, stampFromKey } from "./lib/logStore.js";
import { appendVerify } from "./runlog.js";
import { slackOneoff, alertWebhook, failAlertText } from "./lib/slack.js";
import { githubLogUrl } from "./lib/github.js";
import type { BackupTier } from "./lib/backupTypes.js";

/** Throwaway database every restore is (re)created into — see drillObject()'s "Pristine restore target". */
const SCRATCH_DB = "gitfather_drill";

/** ISO-8601 UTC to seconds precision (matches bash `date -u +%Y-%m-%dT%H:%M:%SZ`). */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

/** Object extension for an ENCRYPTION mode (mirrors backup-pg-to-r2.ts upload). */
export function extForEncryption(encryption: string): string {
  return encryption === "age" ? "dump.age" : encryption === "aes-gcm" ? "dump.enc" : "dump";
}

/** The dump stamp embedded in a key → an ISO-8601 UTC ts (matches a LogRun.ts), or null. */
export function stampToIso(key: string): string | null {
  const m = basename(key).match(/[0-9]{8}T[0-9]{6}Z/);
  if (!m) return null;
  const s = m[0];
  return (
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` +
    `T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`
  );
}

/** Flat config drillObject needs — projected from the Profile by drillCoreFromProfile(). */
export interface DrillCoreConfig {
  backupPrefix: string;
  r2Bucket: string;
  drillDatabaseUrl: string;
  liveDatabaseUrl: string;
  rowCountTable: string;
  /** Tables that must EXIST in the restore (rows optional). */
  presentTables: string[];
  /** Tables that must exist AND have ≥1 row. */
  nonemptyTables: string[];
  minRowRatio: number;
  maxRowRatio: number;
  maxRowDrop: number;
  encryption: "none" | "age" | "aes-gcm";
  ageIdentity?: string;
}

/** Project the validated Profile down to the flat fields drillObject + the verify-durable job share. */
export function drillCoreFromProfile(cfg: Profile): DrillCoreConfig {
  return {
    backupPrefix: cfg.backupPrefix!,
    r2Bucket: cfg.credentials.r2.bucket!,
    drillDatabaseUrl: cfg.credentials.drillDatabaseUrl!,
    liveDatabaseUrl: cfg.credentials.liveDatabaseUrl!,
    rowCountTable: cfg.drill.rowCountTable!,
    presentTables: cfg.drill.presentTables,
    nonemptyTables: cfg.drill.nonemptyTables,
    minRowRatio: cfg.drill.minRowRatio,
    maxRowRatio: cfg.drill.maxRowRatio,
    maxRowDrop: cfg.drill.maxRowDrop,
    encryption: cfg.encryption,
    ageIdentity: cfg.credentials.age.identity,
  };
}

/**
 * Gate mode for the row-count assertion:
 *   "live-ratio" — newest dump, live ≈ dump: assert drill.min-row-ratio × live ≤ restored ≤ drill.max-row-ratio × live.
 *   "nonempty"   — aged durable copy (live has moved on in ~2 weeks, so a live ratio is invalid):
 *                  assert structural validity + the sentinel/expected tables are present & non-empty.
 */
export type DrillGate = "live-ratio" | "nonempty";

/** Result of probing one table: `ok` = the count query RAN (false ⇒ table absent or DB unreachable). */
export interface TableProbe {
  ok: boolean;
  count: number;
}

/**
 * Pure table assertion over a restore — extracted from drillObject so it's unit-testable without a live
 * psql. `present` tables must EXIST (the count query ran; rows optional); `nonempty` tables must exist
 * AND have ≥1 row. A failed query is reported as "missing or unreadable" (we can't tell a dropped table
 * from a dropped connection from count(*) alone, so the message covers both). Records every probed
 * table's count for the drift gate.
 */
export function checkRestoredTables(
  present: string[],
  nonempty: string[],
  probe: (table: string) => TableProbe,
): { ok: boolean; reason: string | null; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const t of present) {
    const r = probe(t);
    counts[t] = r.count;
    if (!r.ok) return { ok: false, reason: `expected table ${t} is missing or unreadable in the restore`, counts };
  }
  for (const t of nonempty) {
    const r = probe(t);
    counts[t] = r.count;
    if (!r.ok) return { ok: false, reason: `table ${t} is missing or unreadable in the restore`, counts };
    if (r.count <= 0) return { ok: false, reason: `restored ${t} is empty/zero`, counts };
  }
  return { ok: true, reason: null, counts };
}

/**
 * Pure restored/reference row-ratio gate. `ref` is what the restored count is measured against:
 *   - "dump-time" — the sentinel's count recorded AT BACKUP TIME (preferred): restored ≈ ref regardless
 *      of how the live table has grown since the dump, so an active table can't false-trip the floor.
 *   - "live"      — an n_live_tup estimate read from the live DB NOW (fallback for dumps predating the
 *      recorded dump-time count): tolerant of rows added since the backup, but drifts for fast-growing tables.
 * Floor (min-row-ratio) catches truncation/stale; ceiling (max-row-ratio) catches duplication. The breach
 * message names which reference was used so a "live" false-positive is distinguishable from a real one.
 */
export function evalRowRatio(
  sentinel: string,
  restored: number,
  ref: number,
  minRowRatio: number,
  maxRowRatio: number,
  refKind: "dump-time" | "live",
): { ok: boolean; ratio: number; reason: string | null } {
  const ratio = Number((restored / ref).toFixed(4));
  if (!(restored >= ref * minRowRatio)) {
    return { ok: false, ratio, reason: `restored ${sentinel} ${restored} < ${minRowRatio}× ${refKind} ${ref} — truncated or stale` };
  }
  if (!(restored <= ref * maxRowRatio)) {
    return { ok: false, ratio, reason: `restored ${sentinel} ${restored} > ${maxRowRatio}× ${refKind} ${ref} — duplicated?` };
  }
  return { ok: true, ratio, reason: null };
}

export interface DrillObjectOpts {
  /** Key UNDER backup-prefix, e.g. "2hourly/<file>" or "daily/<file>". */
  key: string;
  tier: BackupTier;
  gate: DrillGate;
  cfg: DrillCoreConfig;
  tmp: string;
  /** Prior passing drill's per-table counts, for the optional drill.max-row-drop gate. */
  priorCounts?: Record<string, number> | null;
  /** The sentinel's row count recorded AT DUMP TIME for this object (from the run-log), when known.
   * The "live-ratio" gate compares the restored count against this instead of a live-now estimate —
   * eliminating the growth drift that false-tripped the floor. null/absent → fall back to the live estimate. */
  refCount?: number | null;
}

export interface DrillObjectResult {
  ok: boolean;
  ratio: number | null;
  counts: Record<string, number>;
  reason: string | null;
}

/**
 * Download one object, decrypt/decompress, pg_restore it into the throwaway target, and assert the
 * restored data. Returns a result (does NOT exit) so a caller can record + alert + continue. Cleans
 * up its own scratch files so it can be called repeatedly within one tmp dir.
 */
export async function drillObject(opts: DrillObjectOpts): Promise<DrillObjectResult> {
  const { key, gate, cfg, tmp } = opts;
  // Keep the DB passwords off pg_restore/psql argv — they ride in 0600 PGPASSFILEs under `tmp`
  // (removed wholesale when the caller tears `tmp` down, so no per-call cleanup needed here). The
  // `drill` connection is built below, AFTER the scratch DB is (re)created, so it targets a fresh DB.
  const live = pgConn(cfg.liveDatabaseUrl, tmp);
  const counts: Record<string, number> = {};
  const done = (ok: boolean, ratio: number | null, reason: string | null): DrillObjectResult => ({ ok, ratio, counts, reason });

  const obj = join(tmp, "obj");
  const dump = join(tmp, "restore.dump");
  rmSync(obj, { force: true });
  rmSync(dump, { force: true });

  console.log(`Downloading r2:${cfg.r2Bucket}/${cfg.backupPrefix}/${key} …`);
  const dlCode = await run("rclone", ["copyto", `r2:${cfg.r2Bucket}/${cfg.backupPrefix}/${key}`, obj, "--s3-no-check-bucket"]);
  if (dlCode !== 0) return done(false, null, "download failed");

  // ── Decrypt / decompress to a plain custom-format dump ─────────────────────
  if (key.endsWith(".dump.age")) {
    if (!commandExists("age")) return done(false, null, "object is .age but 'age' not found");
    const identity = cfg.ageIdentity;
    if (!identity) return done(false, null, "object is .age but AGE_IDENTITY is unset");
    let isRegularFile = false;
    try {
      isRegularFile = statSync(identity).isFile();
    } catch {
      /* not a path */
    }
    let idfile: string;
    if (isRegularFile) {
      idfile = identity;
    } else {
      idfile = join(tmp, "id");
      writeFileSync(idfile, identity, { mode: 0o600 });
    }
    const code = await runToFile("age", ["-d", "-i", idfile, obj], dump);
    if (code !== 0) return done(false, null, "age decrypt failed");
  } else if (key.endsWith(".dump.enc")) {
    return done(false, null, "object is aes-gcm encrypted but decrypt is not implemented yet");
  } else {
    copyFileSync(obj, dump);
  }

  // ── Pristine restore target ────────────────────────────────────────────────
  // Every restore MUST start against an EMPTY database. A verify-durable job runs several restores
  // per invocation (freshest daily, then aged weekly/monthly) sharing ONE drill server; if the target
  // isn't reset, the 2nd+ restore lands on the previous restore's data → every relation "already
  // exists" and every COPY collides on its primary key ("duplicate key…", "multiple primary keys…").
  // Those are real pg_restore errors, but an artefact of the reused target, NOT the dump — so drop and
  // recreate a scratch DB from the maintenance DB first. (DROP … WITH (FORCE) needs PG13+; the drill
  // target is modern Postgres.)
  const drillAdmin = pgConn(withDatabase(cfg.drillDatabaseUrl, "postgres"), tmp);
  console.log(`Resetting the scratch drill database ${SCRATCH_DB} …`);
  const resetCode = await run(
    "psql",
    [drillAdmin.safeUrl, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`, "-c", `CREATE DATABASE ${SCRATCH_DB}`],
    { env: drillAdmin.env },
  );
  if (resetCode !== 0) return done(false, null, `could not reset the scratch drill database ${SCRATCH_DB}`);
  const drill = pgConn(withDatabase(cfg.drillDatabaseUrl, SCRATCH_DB), tmp);

  // ── Restore into the throwaway target ──────────────────────────────────────
  // Restoring provider-managed schemas into vanilla Postgres emits benign errors (missing
  // roles/extensions); --disable-triggers sidesteps cross-schema FK ordering. pg_restore's bare
  // exit is NOT the gate (it's nonzero on benign noise), but UNRECOGNISED stderr lines now ARE.
  console.log("Restoring into the drill target …");
  const { code: restoreCode, stderr } = await captureStderr(
    "pg_restore",
    ["--no-owner", "--no-privileges", "--no-comments", "--disable-triggers", "-j", "4", "-d", drill.safeUrl, dump],
    { env: drill.env },
  );
  const cls = classifyPgRestoreStderr(stderr);
  if (cls.suspicious.length > 0) {
    for (const line of cls.suspicious) process.stderr.write(`pg_restore (suspicious): ${line}\n`);
    return done(false, null, `pg_restore: ${cls.suspicious.length} unrecognised error(s): ${cls.suspicious[0]}`);
  }
  console.log(
    restoreCode === 0
      ? "pg_restore: clean"
      : `pg_restore: completed with ${cls.benign.length} benign managed-schema line(s) (continuing to row-count check)`,
  );

  // One psql round-trip per table. capture().ok is the "query ran" signal: count(*) on a missing table
  // (or an unreachable drill DB) exits non-zero → ok=false; an existing empty table → ok=true, count=0.
  const probe = (table: string): TableProbe => {
    const r = capture("psql", [drill.safeUrl, "-tAc", `SELECT count(*) FROM public.${table}`], drill.env);
    return { ok: r.ok, count: Number(r.out.replace(/\s/g, "")) || 0 };
  };
  const liveEst = (table: string): string =>
    capture("psql", [
      live.safeUrl,
      "-tAc",
      `SELECT n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' AND relname='${table}'`,
    ], live.env).out.replace(/\s/g, "");

  const sentinel = cfg.rowCountTable;
  const sent = probe(sentinel);
  counts[sentinel] = sent.count;
  if (!sent.ok || sent.count <= 0) return done(false, null, `restored ${sentinel} is empty/zero or unreadable`);
  const restoredNum = sent.count;

  let ratio: number | null = null;
  if (gate === "live-ratio") {
    // Prefer the count recorded AT DUMP TIME (restored ≈ ref, immune to how the live table has grown
    // since); fall back to the live n_live_tup estimate only for dumps that predate that record.
    let refNum: number;
    let refKind: "dump-time" | "live";
    if (opts.refCount != null && opts.refCount > 0) {
      refNum = opts.refCount;
      refKind = "dump-time";
    } else {
      const sentLive = liveEst(sentinel);
      const liveNum = Number(sentLive);
      if (!(sentLive !== "" && liveNum > 0)) return done(false, null, `could not read live ${sentinel} estimate`);
      refNum = liveNum;
      refKind = "live";
    }
    const gateRes = evalRowRatio(sentinel, restoredNum, refNum, cfg.minRowRatio, cfg.maxRowRatio, refKind);
    ratio = gateRes.ratio;
    if (!gateRes.ok) return done(false, ratio, gateRes.reason);
    console.log(`Row-count table public.${sentinel}: restored=${restoredNum} (${refKind}≈${refNum}, ratio ${ratio})`);
  } else {
    console.log(`Row-count table public.${sentinel}: restored=${restoredNum} (nonempty gate — aged copy, no live ratio)`);
  }

  // present-tables (must EXIST; rows optional) + nonempty-tables (must exist AND have ≥1 row). Pure check.
  const tableCheck = checkRestoredTables(cfg.presentTables, cfg.nonemptyTables, probe);
  Object.assign(counts, tableCheck.counts);
  for (const [t, n] of Object.entries(tableCheck.counts)) console.log(`  table public.${t}: restored=${n}`);
  if (!tableCheck.ok) return done(false, ratio, tableCheck.reason);

  // Drift gate (optional): a table that shrank > max-row-drop vs the prior passing drill.
  if (cfg.maxRowDrop > 0 && opts.priorCounts) {
    for (const [t, prev] of Object.entries(opts.priorCounts)) {
      const cur = counts[t];
      if (cur == null || prev <= 0) continue;
      const drop = (prev - cur) / prev;
      if (drop > cfg.maxRowDrop) {
        return done(false, ratio, `table ${t} dropped ${(drop * 100).toFixed(1)}% vs prior drill (${prev}→${cur})`);
      }
    }
  }

  return done(true, ratio, null);
}

/** The sentinel's row count recorded at DUMP time for this object stamp — the live-ratio gate's dump-time
 * reference — or null (no run-log, no matching run, or a run predating the recorded count). Best-effort. */
function dumpTimeRefCount(stamp: string | null, sentinel: string): number | null {
  if (!stamp) return null;
  try {
    return loadLog().runByStamp.get(stamp)?.counts?.[sentinel] ?? null;
  } catch {
    return null;
  }
}

/** Most recent passing RESTORE drill's per-table counts (the drift baseline), best-effort. */
function priorDrillCounts(): Record<string, number> | null {
  try {
    const log = loadLog();
    const prior = log.verifications
      .filter((v) => v.ok && v.counts && v.kind !== "hash")
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
    return prior?.counts ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // Validate + type all config up front (zod); fails fast with one aggregated report. See lib/config.ts.
  const cfg = loadDrillConfig();
  const core = drillCoreFromProfile(cfg);
  const backupPrefix = core.backupPrefix;
  const r2Bucket = core.r2Bucket;
  const r2Account = cfg.credentials.r2.accountId!;
  const r2Key = cfg.credentials.r2.accessKeyId!;
  const r2Secret = cfg.credentials.r2.secretAccessKey!;
  const fileBasename = cfg.name!;

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
    await slackOneoff(failAlertText("restore-drill FAILED", msg, await githubLogUrl()), true).catch(() => {});
    await alertWebhook(`🔴 PG restore-drill FAILED (${fileBasename}): ${msg}`).catch(() => {});
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
  // sort genuinely chronological, so the drill verifies the latest dump. Filtering to the expected
  // extension means a foreign/legacy object can never be selected and mask a real backup.
  const ext = extForEncryption(cfg.encryption);
  console.log(`Finding newest .${ext} object under r2:${r2Bucket}/${backupPrefix}/2hourly/ …`);
  const ls = capture("rclone", ["lsf", "--files-only", `r2:${r2Bucket}/${backupPrefix}/2hourly/`, "--s3-no-check-bucket"]);
  const objs = ls.out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((o) => o.endsWith(`.${ext}`))
    .sort();
  const newest = objs.length ? objs[objs.length - 1] : "";
  if (!newest) await fail(`no .${ext} objects under ${backupPrefix}/2hourly/`);
  const key = `2hourly/${newest}`;
  console.log(`Latest: ${backupPrefix}/${key}`);

  // verifiedTs known the moment the object is selected → fail() paths below can still attribute it.
  const verifiedTs = stampToIso(key);
  const priorCounts = core.maxRowDrop > 0 ? priorDrillCounts() : null;
  const refCount = dumpTimeRefCount(stampFromKey(newest), core.rowCountTable);

  const result = await drillObject({ key, tier: "2hourly", gate: "live-ratio", cfg: core, tmp, priorCounts, refCount });

  // Record the verification — PASS or FAIL (gap #5). Pre-selection failures above have no dump to
  // attribute, so they fail() without a verification; here we always have a selected object.
  if (verifiedTs) {
    appendVerify({
      ts: isoSeconds(new Date()),
      verifiedTs,
      ok: result.ok,
      ratio: result.ratio,
      tier: "2hourly",
      key,
      kind: "restore",
      counts: result.counts,
      reason: result.reason,
    });
  }

  if (!result.ok) await fail(`${result.reason ?? "restore drill failed"} (${key})`);

  const sentCount = result.counts[core.rowCountTable];
  console.log(`✓ Restore drill PASSED: public.${core.rowCountTable} ${sentCount} (ratio ${result.ratio ?? "?"}) — ${key}`);
  await slackOneoff(
    `✅ PG restore-drill OK (${fileBasename}) — ${core.rowCountTable} ${sentCount} (ratio ${result.ratio ?? "?"}) — ${key}`,
  ).catch(() => {});

  cleanup();
}

// Run main() only when invoked directly — this module is also IMPORTED by verify-durable-pg.ts (and the
// tests) for drillObject/checkRestoredTables/extForEncryption/stampToIso, where the standalone drill must NOT run.
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
