import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// MANUAL restore drill of ONE named object — the human half of the verification split.
//
// Where the automated jobs deliberately hold no decrypt key (integrity.verify-before-encrypt proves
// a dump restores BEFORE it is encrypted; verify-durable.keyless re-hashes the stored bytes), this
// is the one thing neither can do: prove that the object sitting in the bucket still OPENS with the
// key we have escrowed. Someone runs it periodically with the offline identity.
//
// It records a `kind: "restore"`, `by: "manual"` verification, which is what lights the dashboard's
// bright cell. Nothing automated can set that any more, on purpose: the bright green means a person
// decrypted and restored that exact object.
//
// Usage — list what is there, then drill one:
//   PROFILE=… npx tsx scripts/drill-object.ts --list
//   AGE_IDENTITY="$(op read 'op://<vault>/<item>/AGE_IDENTITY')" \
//     PROFILE=… npx tsx scripts/drill-object.ts --key monthly/<name>-<stamp>.dump.age
//
//   --key <tier>/<file>   the object to drill, relative to backup-prefix
//   --list                list candidate objects per tier and exit (no key needed)
//   --gate nonempty|live-ratio   default nonempty: a durable copy is usually weeks old, so the live
//                         table has moved on and a ratio against it would be meaningless
//   --no-record           drill but do not write a verification record
//
// AGE_IDENTITY may be the key ITSELF or a path to a file holding it. If you pipe it from 1Password,
// use `op read` (or `--format=json`): the plain `op item get --fields` form wraps a MULTI-LINE value
// in literal double quotes, and age then rejects it with `unknown identity type: "# created: …`.
//
// Required env: R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (read, plus
// write under _log/ to record the result), DRILL_DATABASE_URL (a throwaway Postgres), and
// AGE_IDENTITY for a .age object. Deliberately NOT PG_LIVE_DATABASE_URL — the default gate needs no
// live database, so a routine drill does not hand production credentials to a laptop.
//
// The restore lands in the scratch database `gitfather_drill`, which is DROPPED and recreated each
// time. The dump contains whatever your database contains; run this somewhere you are content for
// that to exist briefly.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManualDrillConfig } from "./lib/config.js";
import { capture, commandExists } from "./lib/proc.js";
import { appendVerify } from "./runlog.js";
import {
  drillCoreFromProfile,
  isDumpObject,
  materialiseDump,
  verifyDumpFile,
  stampToIso,
  type DrillGate,
} from "./restore-drill-pg.js";
import type { BackupTier } from "./lib/backupTypes.js";

const TIERS: BackupTier[] = ["2hourly", "daily", "weekly", "monthly"];

export interface DrillArgs {
  key?: string;
  gate: DrillGate;
  list: boolean;
  record: boolean;
}

/** Pure, and exported so the argument grammar is testable without R2, a key or a database. */
export function parseArgs(argv: string[]): DrillArgs {
  let key: string | undefined;
  let gate: DrillGate = "nonempty";
  let list = false;
  let record = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") list = true;
    else if (a === "--no-record") record = false;
    else if (a === "--key") key = argv[++i];
    else if (a === "--gate") {
      const g = argv[++i];
      if (g !== "nonempty" && g !== "live-ratio") throw new Error(`--gate must be nonempty or live-ratio (got ${g})`);
      gate = g;
    } else throw new Error(`unknown argument ${a}`);
  }
  return { key, gate, list, record };
}

/** The tier a key names, for the verification record. Unparseable → null rather than a guess. */
export function tierOf(key: string): BackupTier | null {
  const head = key.split("/")[0] as BackupTier;
  return TIERS.includes(head) ? head : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadManualDrillConfig();
  const core = drillCoreFromProfile(cfg);
  const r2Bucket = core.r2Bucket;
  const backupPrefix = core.backupPrefix;

  const die = (msg: string): never => {
    process.stderr.write(`ERROR: ${msg}\n`);
    process.exit(1);
  };

  for (const bin of ["rclone", "pg_restore", "psql"]) if (!commandExists(bin)) die(`${bin} not found`);

  process.env.RCLONE_CONFIG_R2_TYPE = "s3";
  process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
  process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = cfg.credentials.r2.accessKeyId!;
  process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = cfg.credentials.r2.secretAccessKey!;
  process.env.RCLONE_CONFIG_R2_ENDPOINT = `https://${cfg.credentials.r2.accountId}.r2.cloudflarestorage.com`;

  if (args.list || !args.key) {
    for (const tier of TIERS) {
      const ls = capture("rclone", ["lsf", "--files-only", `r2:${r2Bucket}/${backupPrefix}/${tier}/`, "--s3-no-check-bucket"]);
      const objs = ls.out.split("\n").map((s) => s.trim()).filter(Boolean).filter(isDumpObject).sort();
      console.log(`\n${tier}/  (${objs.length} object${objs.length === 1 ? "" : "s"})`);
      for (const o of objs) console.log(`  ${tier}/${o}`);
    }
    // Exiting 1 on a BARE run is deliberate: "I printed a list" is not "I verified a backup", and
    // a wrapper that treats a no-args run as success would quietly record neither. An explicit
    // --list is a different thing — the operator asked for exactly this and got it, so it exits 0.
    if (!args.key && !args.list) die("\nno --key given — pick one of the objects above");
    return;
  }

  const key = args.key;
  if (!tierOf(key)) die(`--key must start with a tier (${TIERS.join(" | ")}) — got "${key}"`);
  if (key.endsWith(".dump.age") && !core.ageIdentity) {
    die("that object is age-encrypted but AGE_IDENTITY is unset — this drill exists to use the OFFLINE identity");
  }

  const tmp = mkdtempSync(join(tmpdir(), "pg-manual-drill-"));
  const cleanup = (): void => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  console.log(`Drilling ${backupPrefix}/${key} (gate=${args.gate})`);
  const startedAt = Date.now();

  const got = await materialiseDump({ key, cfg: core, tmp });
  if (!got.ok || !got.dumpPath) die(`could not materialise the object: ${got.reason}`);
  console.log("Decrypted OK — the escrowed identity opens this object.");

  const res = await verifyDumpFile({ dumpPath: got.dumpPath!, gate: args.gate, cfg: core, tmp });
  const tookMs = Date.now() - startedAt;

  if (args.record) {
    // runId/runUrl come back null off a laptop, which is why `by` is recorded explicitly rather
    // than inferred from their absence — an absence is not a statement.
    appendVerify({
      ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      verifiedTs: stampToIso(key) ?? "",
      ok: res.ok,
      ratio: res.ratio,
      tier: tierOf(key),
      key,
      kind: "restore",
      by: "manual",
      counts: res.counts,
      reason: res.reason,
      durationMs: tookMs,
    });
    console.log("Recorded a manual restore verification in the run-log.");
  } else {
    console.log("--no-record: nothing written to the run-log.");
  }

  const secs = Math.round(tookMs / 1000);
  if (!res.ok) die(`drill FAILED after ${secs}s — ${res.reason}`);
  console.log(`\n✓ restore-verified ${backupPrefix}/${key} in ${secs}s`);
  console.log(`  rows: ${Object.entries(res.counts).map(([t, n]) => `${t}=${n}`).join(", ") || "(none probed)"}`);
  console.log("  Record the object key and this result in the drill log.");
}

/** Only run when invoked directly — importing this module for tests must not drill anything. */
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
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
