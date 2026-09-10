import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before anything reads config
// ─────────────────────────────────────────────────────────────────────────────
// Fill the missing `bytes` into an existing archive `_index/`, and change nothing else.
//
//   PROFILE=profiles/example.yaml npx tsx scripts/backfill-archive-sizes.ts [flags]
//
//     --table <name>            only this table (default: every table in the profile)
//     --target r2|local:<dir>   default r2
//     --apply                   actually write; without it this only reports
//     --no-backup               skip the .bak copy of each index file (not recommended)
//
// WHY THIS EXISTS RATHER THAN --rebuild-index. `ArchivedPart.bytes` was added after the first
// indexes were written, so weeks archived before it show a row count and no size on the dashboard.
// --rebuild-index would fix that, but it fixes it by discarding the index and re-deriving every
// week from the manifests — including re-deciding archived-vs-pruned by asking Postgres whether
// each window is empty. That is the right tool for a LOST index and the wrong tool for a missing
// number: a week that was pruned but has since acquired a back-dated row reconciles back to
// `archived`, and the next archiver run then supersedes the real archive with those stragglers.
//
// So this is the narrow instrument, and it is narrow in three ways that matter:
//
//   • IT NEVER OPENS THE DATABASE. There is no connection, no query — which is also why it
//     validates its profile with writesArchives:false, asking for neither the database URL nor the
//     age recipient. Nothing it does can affect a row, a prune gate, or a week's state.
//   • IT ONLY EVER ADDS `bytes`. Every line is round-trip checked (archiveSizes.ts): strip the
//     sizes back off and the result must equal what was read, or the line is put back untouched.
//   • IT KEEPS THE OLD FILE. Each `<table>-<year>.jsonl` is copied to a timestamped `.bak-` sibling
//     before it is replaced. `.bak-` does not end in `.jsonl`, so no reader — the archiver's
//     loadIndex, the dashboard's rclone fetch — will ever pick one up.
//
// The sizes come from a recursive listing of the table's prefix, so they are what the bucket holds
// now rather than what a manifest recorded at write time. That is one API call per table, and it
// is the more honest answer to "how much space does this week occupy".
// ─────────────────────────────────────────────────────────────────────────────

import { parseArgs } from "node:util";
import { archiveSchema, reportConfigError } from "./lib/config.js";
import { buildRawProfile } from "./lib/profile.js";
import { shortTableName } from "./lib/archive.js";
import { makeStore, parseTarget, type Store } from "./lib/store.js";
import { commandExists } from "./lib/proc.js";
import { patchIndexFile, sizeIndexFrom } from "./lib/archiveSizes.js";

const log = (msg: string): void => void process.stdout.write(`${msg}\n`);
const warn = (msg: string): void => void process.stderr.write(`${msg}\n`);

function fail(msg: string): never {
  warn(`✗ ${msg}`);
  process.exit(1);
}

/** JSON.parse that yields null instead of throwing — a malformed line costs its size, not the run. */
function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface TableResult {
  table: string;
  filled: number;
  unmatched: number;
  orphans: number;
  files: number;
}

async function backfillTable(
  store: Store,
  prefix: string,
  table: string,
  apply: boolean,
  backup: boolean,
): Promise<TableResult> {
  const result: TableResult = { table, filled: 0, unmatched: 0, orphans: 0, files: 0 };

  const objects = await store.listSizes(`${prefix}/${table}`);
  const sizes = sizeIndexFrom(objects);
  log(`\n${table}: ${sizes.size} data object(s) in the store`);
  if (sizes.size === 0) {
    log("  nothing to size from — skipping");
    return result;
  }

  // An index file per year, found from the listing rather than guessed: a 52-week window that
  // straddles New Year touches years this table may not have been configured for.
  const indexKeys = objects
    .map((o) => o.key)
    .filter((k) => k.includes("/_index/") && k.endsWith(".jsonl"))
    .sort();
  if (indexKeys.length === 0) {
    log("  no _index/ files — nothing to patch (has this table ever been archived?)");
    return result;
  }

  const seen = new Set<string>();
  for (const key of indexKeys) {
    const body = await store.cat(key);
    if (body == null) {
      warn(`  WARNING ${key} vanished between listing and read — skipped`);
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const label = (parseOrNull(line) as { label?: string } | null)?.label;
      if (typeof label === "string") seen.add(label);
    }
    const patched = patchIndexFile(body, sizes);
    result.filled += patched.filled;
    result.unmatched += patched.unmatched;
    for (const s of patched.skipped) warn(`  WARNING left untouched — ${s}`);

    const year = key.split("/").pop();
    if (!patched.changed) {
      log(`  ${year}: already complete (${patched.unmatched} part(s) have no object to size)`);
      continue;
    }
    result.files++;
    log(`  ${year}: ${patched.filled} part(s) gain a size${patched.unmatched ? `, ${patched.unmatched} still without` : ""}`);
    if (!apply) continue;

    if (backup) {
      const bak = `${key}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await store.putText(body, bak);
      log(`    kept the original at ${bak}`);
    }
    await store.putTextOverwrite(patched.text, key);
    log(`    wrote ${key}`);
  }

  // An object whose week is not in the index at all is not this tool's problem to fix — but it is
  // exactly the symptom --rebuild-index exists for, so say so rather than passing over it.
  for (const [slotKey] of sizes) {
    const week = slotKey.split("#")[0];
    if (!seen.has(week)) result.orphans++;
  }
  if (result.orphans > 0) {
    warn(`  WARNING ${result.orphans} stored part(s) belong to weeks the index does not list.`);
    warn(`          This tool only fills in sizes; re-deriving a missing week needs --rebuild-index.`);
  }
  return result;
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs({
      options: {
        table: { type: "string" },
        target: { type: "string" },
        apply: { type: "boolean", default: false },
        "no-backup": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }).values;
  } catch (e) {
    fail((e as Error).message);
  }

  if (args.help) {
    log("usage: backfill-archive-sizes.ts [--table T] [--target r2|local:<dir>] [--apply] [--no-backup]");
    return;
  }

  let target;
  try {
    target = parseTarget(args.target);
  } catch (e) {
    fail((e as Error).message);
  }

  // writesArchives:false — this script extracts nothing and encrypts nothing, so it must not
  // demand the database URL or the age recipient that an archiving run needs.
  const parsed = archiveSchema({ toR2: target.kind === "r2", writesArchives: false }).safeParse(buildRawProfile());
  if (!parsed.success) {
    reportConfigError(parsed.error);
    process.exit(1);
  }
  const cfg = parsed.data;

  if (target.kind === "r2" && !commandExists("rclone")) fail("rclone not found on PATH");

  if (target.kind === "r2") {
    process.env.RCLONE_CONFIG_R2_TYPE = "s3";
    process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
    process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = cfg.credentials.r2.accessKeyId!;
    process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = cfg.credentials.r2.secretAccessKey!;
    process.env.RCLONE_CONFIG_R2_ENDPOINT = `https://${cfg.credentials.r2.accountId!}.r2.cloudflarestorage.com`;
  }

  const store = makeStore(target, cfg.credentials.r2.bucket);
  const specs = cfg.archive.tables.filter(
    (t) => !args.table || t.table === args.table || t.table.endsWith(`.${args.table}`),
  );
  if (specs.length === 0) fail(`no configured table matches --table "${args.table}"`);

  const apply = args.apply === true;
  log(`backfill-archive-sizes: target=${store.describe} ${apply ? "APPLY" : "report only (pass --apply to write)"}`);

  const results: TableResult[] = [];
  for (const spec of specs) {
    results.push(
      await backfillTable(store, cfg.archive.storePrefix!, shortTableName(spec.table), apply, !args["no-backup"]),
    );
  }

  const filled = results.reduce((n, r) => n + r.filled, 0);
  const unmatched = results.reduce((n, r) => n + r.unmatched, 0);
  log(`\n${apply ? "Filled" : "Would fill"} ${filled} part(s); ${unmatched} still without a size.`);
  if (!apply && filled > 0) log("Re-run with --apply to write.");
}

main().catch((e) => {
  warn(`✗ ${(e as Error).message}`);
  process.exit(1);
});
