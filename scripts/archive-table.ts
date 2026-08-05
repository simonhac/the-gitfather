import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// Archive an append-only table out of Postgres into compressed, encrypted, per-week objects —
// then, as a SEPARATE and independently gated step, delete the rows that were archived.
//
// Built for a table that has outgrown its database: one object per ISO week, a folder per year,
// written once and never rewritten. The engine knows nothing about any particular table; which
// tables, how old, and how aggressively are all profile config (see archive: in profiles/*.yaml).
//
//   PROFILE=profiles/example.yaml npx tsx scripts/archive-table.ts [flags]
//
//     --mode archive|prune|both     default both
//     --table <name>                only this table (default: every table in the profile)
//     --max-weeks <n>               override the profile cap — this is the backfill throttle
//     --target r2|local:<dir>       default r2; local writes REAL artifacts to a directory
//     --dry-run none|source|store   default none (see below)
//     --rebuild-index               re-derive the _index/ cache from the manifests and exit
//
// THE TWO DRY-RUN LEVELS, and why they nest:
//     --dry-run=source   the source database is read-only. The archive is really built, really
//                        uploaded and really verified; the rows simply stay put.
//     --dry-run=store    the store is untouched as well. Artifacts are built and verified in the
//                        work directory and left there for inspection.
//   `store` implies `source`. That is a safety invariant, not a convenience: deleting rows that
//   were never durably stored is the one unrecoverable failure this tool could commit, so there is
//   no combination of flags that deletes without having written. (archive.ts → guardsFor)
//
// WHY PRUNE IS A SEPARATE PHASE. A week is deleted only after its object has been re-downloaded
// and hash-verified, and only if the live (count, XOR-of-md5(id)) fingerprint still matches the
// one recorded in its manifest. Any drift refuses outright. The archive key is deliberately NOT
// available to CI — it is an age recipient whose identity lives offline — which is exactly why
// the gate is built from hashes and fingerprints rather than from decrypting and diffing.
//
// BOTH HALVES RUN AT PRUNE TIME, and the object half is easy to lose. `verify-after-upload` proves
// the bytes landed when the week was ARCHIVED; it says nothing about the object weeks later, and
// prune-after-weeks is deliberately far beyond archive-after-weeks (13 vs 4 in Boost's profile), so
// prune always acts on an object last checked many runs earlier. pruneWeek() therefore re-reads the
// object and re-checks it against the manifest's objectSha256 before any DELETE — without that, an
// object that rotted, was truncated, or was tampered with after archiving is deleted from the
// database anyway, which is the one unrecoverable mistake this tool can make. A zero-row week has no
// object and is exempt (see parsePruneManifest, which gates that exemption on rowCount, not on the
// key being absent).
//
// Required env (credentials — from GitHub secrets, NOT the profile):
//   PG_ARCHIVE_DATABASE_URL   the only task that DELETES; kept separate from the dump's URL
//   AGE_ARCHIVE_RECIPIENT     age public recipient (archive.encryption: age)
//   R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   (unless --target=local:)
// Optional: SLACK_BOT_TOKEN / SLACK_CHANNEL / ALERT_WEBHOOK_URL.
// ─────────────────────────────────────────────────────────────────────────────

import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, statSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSchema, reportConfigError, type ArchiveConfig } from "./lib/config.js";
import { buildRawProfile } from "./lib/profile.js";
import { run, commandExists, bestEffort, sha256File } from "./lib/proc.js";
import { PgArchive } from "./lib/pgArchive.js";
import { githubLogUrl } from "./lib/github.js";
import { appendArchive } from "./runlog.js";
import { slackEnabled, slackPost, alertWebhook, failAlertText } from "./lib/slack.js";
import {
  parseWeekLabel,
  eligibleWeeks,
  isWeekEligible,
  newestEligibleWeek,
  archiveObjectKey,
  manifestObjectKey,
  indexObjectKey,
  planArchive,
  planPrune,
  parsePruneManifest,
  activePart,
  sameFingerprint,
  parseDryRun,
  guardsFor,
  FingerprintAccumulator,
  type Fingerprint,
  type IsoWeek,
  type WeekState,
  type ArchivedPart,
} from "./lib/archive.js";
import { makeStore, parseTarget, SuppressedStore, type Store } from "./lib/store.js";

const SCRIPT_START_MS = Date.now();

// ── Manifest ─────────────────────────────────────────────────────────────────

/**
 * The plaintext sidecar written beside every archive object. It holds NO row data, which is what
 * lets it stay unencrypted — and that is the point: the archive has to be reasoned about (planned,
 * gated, pruned, audited) by a process that cannot decrypt it.
 */
interface Manifest {
  schemaVersion: 1;
  project: string;
  table: string;
  week: string;
  part: number;
  role: ArchivedPart["role"];
  windowStart: string;
  windowEnd: string;
  timeColumn: string;
  rowCount: number;
  fingerprint: Fingerprint;
  /** null for a zero-row week, which gets a manifest but no data object so the gap is explained. */
  objectKey: string | null;
  objectBytes: number | null;
  objectSha256: string | null;
  plaintextSha256: string | null;
  compression: string;
  encryption: { scheme: string; recipient: string | null };
  producedAt: string;
  supersedes?: number[];
  anomaly?: boolean;
}

interface WeekRecord extends WeekState {
  updatedAt: string;
}

// ── Small helpers ────────────────────────────────────────────────────────────

const log = (msg: string): void => void process.stdout.write(`${msg}\n`);
const warn = (msg: string): void => void process.stderr.write(`${msg}\n`);

function fail(msg: string): never {
  warn(`✗ ${msg}`);
  process.exit(1);
}

/** Compression/encryption suffixes, in the order they are applied. */
function extensionFor(compression: string, encryption: string): string {
  const comp = compression === "zstd" ? ".zst" : compression === "gzip" ? ".gz" : "";
  const enc = encryption === "age" ? ".age" : "";
  return `ndjson${comp}${enc}`;
}

/** Streaming fingerprint + SHA-256 of an NDJSON file, in one pass. */
function readNdjson(path: string): Promise<{ fingerprint: Fingerprint; sha256: string }> {
  return new Promise((resolve, reject) => {
    const acc = new FingerprintAccumulator();
    const stream = createReadStream(path, { encoding: "utf8" });
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      try {
        acc.push(chunk as string);
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    });
    stream.on("close", () => {
      /* destroyed by an error above; the reject already fired */
    });
    stream.on("end", () => {
      try {
        const fingerprint = acc.finish();
        sha256File(path).then((sha256) => resolve({ fingerprint, sha256 }), reject);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ── The _index/ cache ────────────────────────────────────────────────────────
// A materialised view of the manifests, never the truth. Losing it costs a --rebuild-index,
// not data; that is why it is the one key allowed to be rewritten in place.

async function loadIndex(store: Store, prefix: string, table: string): Promise<Map<string, WeekRecord>> {
  const states = new Map<string, WeekRecord>();
  const keys = await store.list(`${prefix}/${table}/_index`);
  for (const key of keys.filter((k) => k.endsWith(".jsonl"))) {
    const body = (await store.cat(key)) ?? "";
    for (const line of body.split("\n").map((s) => s.trim()).filter(Boolean)) {
      const rec = JSON.parse(line) as WeekRecord;
      states.set(rec.label, rec);
    }
  }
  return states;
}

async function writeIndexYear(
  store: Store,
  prefix: string,
  table: string,
  year: number,
  states: Map<string, WeekRecord>,
): Promise<void> {
  const lines = [...states.values()]
    .filter((s) => parseWeekLabel(s.label).year === year)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((s) => JSON.stringify(s));
  await store.putTextOverwrite(lines.join("\n") + "\n", indexObjectKey({ prefix, table, year }));
}

/**
 * Re-derive the index from the manifests actually present — the recovery path when the derived
 * _index/ is lost or wrong.
 *
 * Manifests record what was WRITTEN and never what was deleted, so the objects alone cannot say
 * whether a week was pruned. Rather than guess, this reconciles each week against the LIVE table:
 * a window whose rows are gone but whose archive holds rows was evidently pruned. Without that,
 * a rebuild over an already-pruned archive would mark every week `archived`, and every later prune
 * run would refuse all of them ("archived 400 rows, live 0") and exit non-zero forever — safe, but
 * a recovery tool that leaves the job permanently alarming is not much of a recovery tool.
 */
async function rebuildIndex(
  store: Store,
  prefix: string,
  table: string,
  pg: PgArchive,
  spec: ArchiveConfig["archive"]["tables"][number],
): Promise<number> {
  const keys = (await store.list(`${prefix}/${table}`)).filter((k) => k.endsWith(".manifest.json"));
  const states = new Map<string, WeekRecord>();
  for (const key of keys) {
    const m = JSON.parse((await store.cat(key)) ?? "{}") as Manifest;
    if (!m.week) continue;
    const existing = states.get(m.week);
    const parts = [...(existing?.parts ?? [])];
    // A part superseded by a later one is recorded as such, exactly as the live path would.
    for (const n of m.supersedes ?? []) {
      const prior = parts.find((p) => p.part === n);
      if (prior) prior.role = "superseded";
    }
    parts.push({ part: m.part, role: m.role, rowCount: m.rowCount, fingerprint: m.fingerprint });
    states.set(m.week, {
      label: m.week,
      state: "archived", // provisional; reconciled against the live table below
      parts: parts.sort((a, b) => a.part - b.part),
      updatedAt: new Date().toISOString(),
    });
  }
  // Reconcile: a window the archive holds rows for, but the table no longer does, was pruned.
  // Anything else stays `archived`, so a genuine mismatch still reaches the prune gate and is
  // reported rather than papered over.
  for (const [label, rec] of states) {
    const active = activePart(rec.parts);
    if (!active || active.fingerprint.n === 0) continue;
    const live = pg.fingerprint(spec.table, spec.timeColumn, parseWeekLabel(label));
    if (live.n === 0) states.set(label, { ...rec, state: "pruned" });
  }

  const years = new Set([...states.keys()].map((l) => parseWeekLabel(l).year));
  for (const year of years) await writeIndexYear(store, prefix, table, year, states);
  return states.size;
}

// ── Per-week archive ─────────────────────────────────────────────────────────

interface TableRun {
  table: string;
  archived: number;
  rowsArchived: number;
  pruned: number;
  rowsPruned: number;
  skipped: number;
  bytesWritten: number;
  refusals: string[];
  anomalies: string[];
}

async function archiveWeek(ctx: {
  cfg: ArchiveConfig;
  pg: PgArchive;
  store: Store;
  workDir: string;
  prefix: string;
  name: string;
  table: string;
  timeColumn: string;
  week: IsoWeek;
  states: Map<string, WeekRecord>;
  mayWriteStore: boolean;
  result: TableRun;
}): Promise<void> {
  const { cfg, pg, store, workDir, prefix, name, table, timeColumn, week, states, mayWriteStore, result } = ctx;
  const short = table.includes(".") ? table.split(".").pop()! : table;

  const live = pg.fingerprint(table, timeColumn, week);
  const plan = planArchive(states.get(week.label), live);
  if (plan.action === "skip") {
    result.skipped++;
    return;
  }
  if (plan.anomaly) {
    const msg = `${table} ${week.label}: ${live.n} row(s) present in an ALREADY-PRUNED week — archiving as a supplement`;
    warn(`⚠ ${msg}`);
    result.anomalies.push(msg);
  }

  const part = plan.part!;
  const compression = cfg.archive.compression;
  const encryption = cfg.archive.encryption;
  const recipient = cfg.credentials.age.archiveRecipient ?? null;
  const ext = extensionFor(compression, encryption);
  const dataKey = archiveObjectKey({ prefix, name, table: short, week, part, ext });
  const manKey = manifestObjectKey({ prefix, name, table: short, week, part });

  let manifest: Manifest = {
    schemaVersion: 1,
    project: name,
    table,
    week: week.label,
    part,
    role: plan.role!,
    windowStart: week.start.toISOString(),
    windowEnd: week.end.toISOString(),
    timeColumn,
    rowCount: live.n,
    fingerprint: live,
    objectKey: null,
    objectBytes: null,
    objectSha256: null,
    plaintextSha256: null,
    compression,
    encryption: { scheme: encryption, recipient },
    producedAt: new Date().toISOString(),
    ...(plan.supersedes?.length ? { supersedes: plan.supersedes } : {}),
    ...(plan.anomaly ? { anomaly: true } : {}),
  };

  if (live.n > 0) {
    // 1 — extract
    const ndjson = join(workDir, `${short}-${week.label}-p${part}.ndjson`);
    await pg.extract(table, timeColumn, week, ndjson);

    // 2 — verify the stream against what SQL said BEFORE anything downstream trusts it. A psql
    //     stream killed mid-row is the CB-194 failure class; catching it here means the object is
    //     never written, rather than written short and later relied upon by a prune.
    const { fingerprint: fileFp, sha256: plaintextSha256 } = await readNdjson(ndjson);
    if (!sameFingerprint(fileFp, live)) {
      throw new Error(
        `${table} ${week.label}: extracted ${fileFp.n} rows (digest ${fileFp.digest}) but the table reported ` +
          `${live.n} (digest ${live.digest}) — refusing to archive a stream that does not match its source`,
      );
    }

    // 3 — compress, then encrypt. Staged through files rather than one long pipe so each
    //     intermediate is inspectable under --dry-run=store.
    let current = ndjson;
    if (compression === "zstd") {
      const out = `${current}.zst`;
      if ((await run("zstd", ["-q", `-${cfg.archive.compressionLevel}`, "-o", out, current])) !== 0) {
        throw new Error(`zstd failed for ${week.label}`);
      }
      current = out;
    } else if (compression === "gzip") {
      const out = `${current}.gz`;
      const level = Math.min(9, cfg.archive.compressionLevel);
      if ((await run("sh", ["-c", `gzip -${level} -c "${current}" > "${out}"`])) !== 0) {
        throw new Error(`gzip failed for ${week.label}`);
      }
      current = out;
    }
    if (encryption === "age") {
      const out = `${current}.age`;
      if ((await run("age", ["-r", recipient!, "-o", out, current])) !== 0) {
        throw new Error(`age failed for ${week.label}`);
      }
      current = out;
    }

    const objectSha256 = await sha256File(current);
    const objectBytes = statSync(current).size;
    manifest = { ...manifest, objectKey: dataKey, objectBytes, objectSha256, plaintextSha256 };

    if (mayWriteStore) {
      await store.put(current, dataKey);
      // 4 — verify after upload, ALWAYS. The prune gate is only worth as much as the proof that
      //     the bytes made it, and unlike the dumps there is no second copy to fall back on.
      const back = join(workDir, `verify-${short}-${week.label}-p${part}.bin`);
      await store.fetchToFile(dataKey, back);
      const backSha = await sha256File(back);
      rmSync(back, { force: true });
      if (backSha !== objectSha256) {
        throw new Error(`${week.label}: uploaded object re-read as ${backSha}, expected ${objectSha256}`);
      }
    }
  }

  if (mayWriteStore) {
    await store.putText(JSON.stringify(manifest, null, 2) + "\n", manKey);
  }

  // Record the new part locally; the index file is flushed once per year at the end.
  const prior = states.get(week.label);
  const parts: ArchivedPart[] = [...(prior?.parts ?? [])];
  for (const n of plan.supersedes ?? []) {
    const p = parts.find((x) => x.part === n);
    if (p) p.role = "superseded";
  }
  parts.push({ part, role: plan.role!, rowCount: live.n, fingerprint: live });
  states.set(week.label, {
    label: week.label,
    state: prior?.state === "pruned" ? "pruned" : "archived",
    parts: parts.sort((a, b) => a.part - b.part),
    updatedAt: new Date().toISOString(),
  });

  result.archived++;
  result.rowsArchived += live.n;
  result.bytesWritten += manifest.objectBytes ?? 0;
  const size = manifest.objectBytes === null ? "no data object" : `${(manifest.objectBytes / 1024).toFixed(1)} KiB`;
  log(`  ${plan.action} ${week.label} p${part}: ${live.n} rows, ${size}${mayWriteStore ? "" : " (store suppressed)"}`);
}

// ── Per-week prune ───────────────────────────────────────────────────────────

async function pruneWeek(ctx: {
  pg: PgArchive;
  store: Store;
  workDir: string;
  prefix: string;
  name: string;
  table: string;
  timeColumn: string;
  week: IsoWeek;
  batchRows: number;
  states: Map<string, WeekRecord>;
  mayDeleteRows: boolean;
  result: TableRun;
}): Promise<void> {
  const { pg, store, workDir, prefix, name, table, timeColumn, week, batchRows, states, mayDeleteRows, result } = ctx;
  const short = table.includes(".") ? table.split(".").pop()! : table;
  const state = states.get(week.label);
  const live = pg.fingerprint(table, timeColumn, week);
  const plan = planPrune(state, live);

  if (plan.action === "skip") return;
  if (plan.action === "refuse") {
    const msg = `${table} ${week.label}: prune REFUSED — ${plan.reason}`;
    warn(`⚠ ${msg}`);
    result.refusals.push(msg);
    return;
  }

  // The live table matches the manifest — but that says nothing about the ARCHIVE still being
  // intact. Re-read the object and check it against the hash recorded when it was written. This
  // runs before the mayDeleteRows gate on purpose, so a --dry-run=source rehearsal exercises the
  // same proof a real prune depends on. Read-only: SuppressedStore passes reads through.
  const manKey = manifestObjectKey({ prefix, name, table: short, week, part: plan.part! });
  const man = parsePruneManifest(await store.cat(manKey), plan.part!);
  if ("error" in man) {
    const msg = `${table} ${week.label}: prune REFUSED — ${man.error}`;
    warn(`⚠ ${msg}`);
    result.refusals.push(msg);
    return;
  }
  if (!("nothingToVerify" in man)) {
    const reread = join(workDir, `prune-verify-${short}-${week.label}-p${plan.part}.bin`);
    let actualSha: string;
    try {
      await store.fetchToFile(man.objectKey, reread);
      actualSha = await sha256File(reread);
    } catch (e) {
      const msg = `${table} ${week.label}: prune REFUSED — could not re-read ${man.objectKey}: ${(e as Error).message}`;
      warn(`⚠ ${msg}`);
      result.refusals.push(msg);
      return;
    } finally {
      rmSync(reread, { force: true });
    }
    if (actualSha !== man.objectSha256) {
      const msg =
        `${table} ${week.label}: prune REFUSED — archived object ${man.objectKey} re-read as ${actualSha}, ` +
        `expected ${man.objectSha256} (the archive has changed since it was written; rows NOT deleted)`;
      warn(`⚠ ${msg}`);
      result.refusals.push(msg);
      return;
    }
  }

  if (!mayDeleteRows) {
    log(`  would prune ${week.label}: ${plan.expectRows} rows (source read-only)`);
    return;
  }

  const deleted = await pg.deleteWindow({
    table,
    timeColumn,
    week,
    batchRows,
    expectRows: plan.expectRows!,
  });
  if (deleted !== plan.expectRows) {
    const msg = `${table} ${week.label}: deleted ${deleted} rows but expected ${plan.expectRows}`;
    warn(`⚠ ${msg}`);
    result.refusals.push(msg);
    return;
  }

  states.set(week.label, { ...state!, state: "pruned", updatedAt: new Date().toISOString() });
  result.pruned++;
  result.rowsPruned += deleted;
  log(`  pruned ${week.label}: ${deleted} rows`);
}

// ── Per-table driver ─────────────────────────────────────────────────────────

async function processTable(ctx: {
  cfg: ArchiveConfig;
  spec: ArchiveConfig["archive"]["tables"][number];
  pg: PgArchive;
  store: Store;
  workDir: string;
  now: Date;
  mode: "archive" | "prune" | "both";
  maxWeeksOverride?: number;
  guards: { mayWriteStore: boolean; mayDeleteRows: boolean };
}): Promise<TableRun> {
  const { cfg, spec, pg, store, workDir, now, mode, maxWeeksOverride, guards } = ctx;
  const prefix = cfg.archive.storePrefix!;
  const name = cfg.name!;
  const table = spec.table;
  const short = table.includes(".") ? table.split(".").pop()! : table;
  const timeColumn = spec.timeColumn;
  const result: TableRun = {
    table,
    archived: 0,
    rowsArchived: 0,
    pruned: 0,
    rowsPruned: 0,
    skipped: 0,
    bytesWritten: 0,
    refusals: [],
    anomalies: [],
  };

  log(`\n▸ ${table} (time column ${timeColumn}) → ${store.describe}`);
  const states = await loadIndex(store, prefix, short);
  const oldest = pg.oldestRowAt(table, timeColumn);
  log(`  index: ${states.size} known week(s); oldest live row: ${oldest ? oldest.toISOString() : "(table empty)"}`);

  const touchedYears = new Set<number>();

  if (mode === "archive" || mode === "both") {
    const maxWeeks = maxWeeksOverride ?? spec.maxWeeksPerRun;
    const pruned = new Set([...states.values()].filter((s) => s.state === "pruned").map((s) => s.label));
    const candidates = eligibleWeeks({
      now,
      oldestRowAt: oldest,
      afterWeeks: spec.archiveAfterWeeks,
      maxWeeks,
      done: pruned,
    });

    // The anomaly sweep: ONE query asking whether any rows sit behind the point from which we are
    // about to work forward. In the steady state it returns nothing; when it returns a week, that
    // week was already pruned and has somehow regained rows, so it is added back as a candidate.
    if (oldest) {
      const watermark = candidates[0]?.start ?? newestEligibleWeek(now, spec.archiveAfterWeeks).end;
      for (const label of pg.anomalousWeeks(table, timeColumn, watermark)) {
        if (candidates.some((w) => w.label === label)) continue;
        const w = parseWeekLabel(label);
        if (!isWeekEligible(w, now, spec.archiveAfterWeeks)) continue;
        candidates.push(w);
      }
      candidates.sort((a, b) => a.start.getTime() - b.start.getTime());
    }

    log(`  archive: ${candidates.length} week(s) eligible (cap ${maxWeeks})`);
    for (const week of candidates) {
      await archiveWeek({
        cfg,
        pg,
        store,
        workDir,
        prefix,
        name,
        table,
        timeColumn,
        week,
        states,
        mayWriteStore: guards.mayWriteStore,
        result,
      });
      touchedYears.add(week.year);
    }
  }

  if (mode === "prune" || mode === "both") {
    const ready = [...states.values()]
      .filter((s) => s.state === "archived")
      .map((s) => parseWeekLabel(s.label))
      .filter((w) => isWeekEligible(w, now, spec.pruneAfterWeeks))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    log(`  prune: ${ready.length} archived week(s) past the ${spec.pruneAfterWeeks}-week horizon`);
    for (const week of ready) {
      await pruneWeek({
        pg,
        store,
        workDir,
        prefix,
        name,
        table,
        timeColumn,
        week,
        batchRows: spec.deleteBatchRows,
        states,
        mayDeleteRows: guards.mayDeleteRows,
        result,
      });
      touchedYears.add(week.year);
    }
  }

  if (guards.mayWriteStore) {
    for (const year of touchedYears) await writeIndexYear(store, prefix, short, year, states);
  }
  return result;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs({
      options: {
        mode: { type: "string", default: "both" },
        table: { type: "string" },
        "max-weeks": { type: "string" },
        target: { type: "string" },
        "dry-run": { type: "string" },
        "rebuild-index": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }).values;
  } catch (e) {
    fail((e as Error).message);
  }

  if (args.help) {
    log("usage: archive-table.ts [--mode archive|prune|both] [--table T] [--max-weeks N]");
    log("       [--target r2|local:<dir>] [--dry-run none|source|store] [--rebuild-index]");
    return;
  }

  const mode = args.mode as "archive" | "prune" | "both";
  if (!["archive", "prune", "both"].includes(mode)) fail(`invalid --mode "${args.mode}"`);

  let target, dryRun;
  try {
    target = parseTarget(args.target);
    dryRun = parseDryRun(args["dry-run"]);
  } catch (e) {
    fail((e as Error).message);
  }
  const guards = guardsFor(dryRun);

  const parsed = archiveSchema({ toR2: target.kind === "r2" }).safeParse(buildRawProfile());
  if (!parsed.success) {
    reportConfigError(parsed.error);
    process.exit(1);
  }
  const cfg = parsed.data;

  for (const bin of ["psql", ...(cfg.archive.compression === "zstd" ? ["zstd"] : [])].concat(
    cfg.archive.encryption === "age" ? ["age"] : [],
    target.kind === "r2" ? ["rclone"] : [],
  )) {
    if (!commandExists(bin)) fail(`${bin} not found on PATH`);
  }

  if (target.kind === "r2") {
    process.env.RCLONE_CONFIG_R2_TYPE = "s3";
    process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
    process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = cfg.credentials.r2.accessKeyId!;
    process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = cfg.credentials.r2.secretAccessKey!;
    process.env.RCLONE_CONFIG_R2_ENDPOINT = `https://${cfg.credentials.r2.accountId!}.r2.cloudflarestorage.com`;
  }

  const base = makeStore(target, cfg.credentials.r2.bucket);
  const store: Store = guards.mayWriteStore ? base : new SuppressedStore(base);

  const workDir = mkdtempSync(join(tmpdir(), "gf-archive-"));
  const cleanup = (): void => rmSync(workDir, { recursive: true, force: true });
  // --dry-run=store exists so a human can look at what WOULD have been written, so keep the
  // artifacts in that mode and tell them where to find them.
  const keepWork = dryRun === "store";
  if (!keepWork) {
    process.on("exit", cleanup);
    process.on("SIGINT", () => process.exit(130));
    process.on("SIGTERM", () => process.exit(143));
  }

  const specs = cfg.archive.tables.filter((t) => !args.table || t.table === args.table || t.table.endsWith(`.${args.table}`));
  if (specs.length === 0) fail(`no configured table matches --table "${args.table}"`);

  log(`archive-table: mode=${mode} target=${store.describe} dry-run=${dryRun}`);
  if (dryRun !== "none") log(`  guards: writeStore=${guards.mayWriteStore} deleteRows=${guards.mayDeleteRows}`);

  const pg = new PgArchive(cfg.credentials.archiveDatabaseUrl!, workDir);
  const results: TableRun[] = [];
  let failure: Error | null = null;

  try {
    if (args["rebuild-index"]) {
      for (const spec of specs) {
        const short = spec.table.includes(".") ? spec.table.split(".").pop()! : spec.table;
        const n = await rebuildIndex(store, cfg.archive.storePrefix!, short, pg, spec);
        log(`rebuilt index for ${spec.table}: ${n} week(s)`);
      }
    } else {
      const now = new Date();
      const maxWeeksOverride = args["max-weeks"] === undefined ? undefined : Number(args["max-weeks"]);
      if (maxWeeksOverride !== undefined && (!Number.isInteger(maxWeeksOverride) || maxWeeksOverride < 1)) {
        fail(`invalid --max-weeks "${args["max-weeks"]}"`);
      }
      for (const spec of specs) {
        results.push(await processTable({ cfg, spec, pg, store, workDir, now, mode, maxWeeksOverride, guards }));
      }
    }
  } catch (e) {
    failure = e as Error;
  } finally {
    pg.cleanup();
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const refusals = results.flatMap((r) => r.refusals);
  const anomalies = results.flatMap((r) => r.anomalies);
  const nowIso = new Date().toISOString();
  for (const r of results) {
    log(
      `\n${r.table}: archived ${r.archived} week(s)/${r.rowsArchived} rows · ` +
        `pruned ${r.pruned} week(s)/${r.rowsPruned} rows · skipped ${r.skipped}`,
    );
    // Recorded even for QUIET runs and for --dry-run=source, so an absent record means the job did
    // not run rather than "it ran and had nothing to say".
    //
    // But NOT when the store is suppressed, and not for a local target. The run-log lives in R2, so
    // appending during --dry-run=store would write to the very store that mode promises to leave
    // untouched; and a --target=local: rehearsal has no business posting a record to production.
    if (!guards.mayWriteStore || target.kind !== "r2") continue;
    await bestEffort("runlog archive", () =>
      appendArchive({
        ts: nowIso,
        ok: !failure && r.refusals.length === 0 && r.anomalies.length === 0,
        table: r.table,
        mode,
        dryRun,
        weeksArchived: r.archived,
        rowsArchived: r.rowsArchived,
        weeksPruned: r.pruned,
        rowsPruned: r.rowsPruned,
        bytes: r.bytesWritten,
        refusals: r.refusals.length,
        anomalies: r.anomalies.length,
        error: failure ? failure.message : null,
        durationMs: Date.now() - SCRIPT_START_MS,
      }),
    );
  }
  if (keepWork) log(`\n--dry-run=store: artifacts left in ${workDir}`);

  const durationMs = Date.now() - SCRIPT_START_MS;
  const label = `${cfg.name} archive`;

  if (failure) {
    warn(`\n✗ ${failure.message}`);
    if (slackEnabled()) {
      const logUrl = await githubLogUrl();
      await bestEffort("slack fail alert", () =>
        slackPost(`${cfg.slack.alertMention || "<!here>"} ${failAlertText(`${label} FAILED`, failure!.message, logUrl)}`, {
          broadcast: true,
        }),
      );
    }
    await bestEffort("alert webhook", () => alertWebhook(`🔴 ${label} FAILED — ${failure!.message}`));
    process.exit(1);
  }

  if (refusals.length || anomalies.length) {
    // Neither is a crash — the rows are all still there — but both mean a human needs to look,
    // so they page rather than sitting quietly in a log nobody reads.
    const lines = [...refusals, ...anomalies].map((m) => `• ${m}`).join("\n");
    warn(`\n⚠ ${refusals.length} refusal(s), ${anomalies.length} anomaly(ies)`);
    if (slackEnabled()) {
      await bestEffort("slack anomaly alert", () =>
        slackPost(`${cfg.slack.alertMention || "<!here>"} 🟠 *${label}* needs attention:\n${lines}`, {
          broadcast: true,
        }),
      );
    }
    await bestEffort("alert webhook", () => alertWebhook(`🟠 ${label} needs attention:\n${lines}`));
    process.exit(1);
  }

  if (slackEnabled() && dryRun === "none" && results.some((r) => r.archived || r.pruned)) {
    const summary = results
      .map((r) => `${r.table}: +${r.archived}w/${r.rowsArchived} rows archived, −${r.pruned}w/${r.rowsPruned} rows pruned`)
      .join("\n");
    await bestEffort("slack summary", () => slackPost(`🗄️ *${label}* ok in ${(durationMs / 1000).toFixed(1)}s\n${summary}`));
  }

  log(`\n✓ done in ${(durationMs / 1000).toFixed(1)}s`);
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
