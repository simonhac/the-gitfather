// ─────────────────────────────────────────────────────────────────────────────
// End-to-end archive → verify → prune against a REAL Postgres.
//
// The unit tests cover the pure logic; this covers everything they cannot — that psql's
// unaligned output really does survive round-tripping rows full of backslashes, quotes and
// escaped newlines; that the fingerprint Node computes really does equal the one Postgres
// computes; and that prune deletes exactly the archived rows and nothing else.
//
// Skips (rather than fails) when no Postgres is reachable, so the suite still runs on a
// machine without one. Point it somewhere with:
//   ARCHIVE_TEST_DATABASE_URL=postgresql://localhost:5432/postgres?sslmode=disable npm test
// It creates and drops its OWN scratch database and never touches anything else.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { xorDigest, isoWeekOf, prevWeek, type IsoWeek } from "../lib/archive.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN_URL = process.env.ARCHIVE_TEST_DATABASE_URL ?? "postgresql://localhost:5432/postgres?sslmode=disable";
const DB = `gf_archive_test_${process.pid}`;

const md5 = (s: string): string => createHash("md5").update(s, "utf8").digest("hex");

/** psql with the ambient PGSSLROOTCERT cleared — a `system` value rejects sslmode=disable outright. */
function psql(url: string, sql: string): string {
  return execFileSync("psql", [url, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    env: { ...process.env, PGSSLROOTCERT: "" },
  }).trim();
}

function pgAvailable(): string | false {
  try {
    psql(ADMIN_URL, "select 1");
    return false;
  } catch {
    return "no Postgres reachable (set ARCHIVE_TEST_DATABASE_URL)";
  }
}
const skip = pgAvailable();

const dbUrl = (): string => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${DB}`;
  return u.toString();
};

// Rows engineered to break a naive extractor: literal backslashes, quotes, an ESCAPED newline
// (which must not split the NDJSON row), tabs, unicode, and a body far past any line buffer.
const NASTY = [
  String.raw`{"nested":"{\"deep\":1}"}`,
  'back\\slash and a "quote"',
  "line one\nline two\ttabbed",
  "unicode ✓ — em-dash, emoji 🗄️, nul-ish \\u0000",
  "x".repeat(300_000),
  "",
];

/**
 * Weeks are chosen RELATIVE TO NOW so the expected set never depends on the calendar date.
 * With archive-after-weeks: 1, the newest eligible week is W(n-2) — W(n-1) has not yet ended
 * a full week ago — so seeding W(n-5)..W(n-3) makes the eligible range exactly four weeks:
 * three with rows, and W(n-2) empty. That empty week is the point: it still gets a manifest,
 * so a gap in the archive is explained rather than mysterious.
 */
function weeksBackFromNow(n: number): IsoWeek {
  let w = isoWeekOf(new Date());
  for (let i = 0; i < n; i++) w = prevWeek(w);
  return w;
}
const DATA_WEEKS = [weeksBackFromNow(5), weeksBackFromNow(4), weeksBackFromNow(3)];
const EMPTY_WEEK = weeksBackFromNow(2);

function seed(): void {
  psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${DB}`);
  psql(ADMIN_URL, `CREATE DATABASE ${DB}`);
  const url = dbUrl();
  psql(
    url,
    `CREATE TABLE public.widget_logs (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       created_at timestamptz NOT NULL,
       service text NOT NULL,
       payload text
     )`,
  );
  const rows: string[] = [];
  DATA_WEEKS.forEach((week, wi) => {
    for (let i = 0; i < 4; i++) {
      const ts = new Date(week.start.getTime() + (i + 1) * 3_600_000).toISOString();
      const payload = NASTY[(wi * 4 + i) % NASTY.length].replace(/'/g, "''");
      rows.push(`('${ts}'::timestamptz, 'svc${wi}', '${payload}')`);
    }
  });
  psql(url, `INSERT INTO public.widget_logs (created_at, service, payload) VALUES ${rows.join(",")}`);
  psql(url, `INSERT INTO public.widget_logs (created_at, service, payload) VALUES (now(), 'current', 'do not archive')`);
}

function writeProfile(dir: string, encryption: "none" | "age" = "none"): string {
  const path = join(dir, "profile.yaml");
  writeFileSync(
    path,
    [
      "name: test",
      "backup-prefix: pg/test",
      "timezone: UTC",
      "archive:",
      "  store-prefix: archive/test",
      `  encryption: ${encryption}`,
      "  compression: zstd",
      "  compression-level: 3",
      "  tables:",
      "    - table: public.widget_logs",
      "      time-column: created_at",
      "      archive-after-weeks: 1",
      "      prune-after-weeks: 1",
      "      delete-batch-rows: 3", // deliberately smaller than a week's rows, so batching really loops
      "      max-weeks-per-run: 100",
      "",
    ].join("\n"),
  );
  return path;
}

function runArchiver(profile: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync(join(REPO, "node_modules", ".bin", "tsx"), [join(REPO, "scripts", "archive-table.ts"), ...args], {
    encoding: "utf8",
    cwd: REPO,
    env: {
      ...process.env,
      PGSSLROOTCERT: "",
      PROFILE: profile,
      PG_ARCHIVE_DATABASE_URL: dbUrl(),
      SLACK_BOT_TOKEN: "",
      SLACK_CHANNEL: "",
      ...extraEnv,
    },
  }).replace(/\s+$/, "");
}

const listFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p.slice(dir.length + 1));
    }
  };
  walk(dir);
  return out.sort();
};

test("archive → verify → prune, end to end against real Postgres", { skip }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "gf-archive-it-"));
  const storeDir = join(work, "store");
  t.after(() => {
    try {
      psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    } catch {
      /* best effort */
    }
    rmSync(work, { recursive: true, force: true });
  });

  seed();
  const profile = writeProfile(work);
  const liveTotal = Number(psql(dbUrl(), "SELECT count(*) FROM public.widget_logs"));
  assert.equal(liveTotal, 13, "12 archivable rows across 3 weeks + 1 in the current week");

  // ── --dry-run=store writes nothing at all ────────────────────────────────
  runArchiver(profile, ["--mode", "archive", "--target", `local:${storeDir}`, "--dry-run", "store"]);
  assert.deepEqual(listFiles(storeDir), [], "a store dry run must not create a single object");
  assert.equal(Number(psql(dbUrl(), "SELECT count(*) FROM public.widget_logs")), 13, "and must not delete a row");

  // ── archive for real, to the local sink ──────────────────────────────────
  runArchiver(profile, ["--mode", "archive", "--target", `local:${storeDir}`]);
  const files = listFiles(storeDir);
  const data = files.filter((f) => f.endsWith(".ndjson.zst"));
  const manifests = files.filter((f) => f.endsWith(".manifest.json"));

  assert.equal(data.length, 3, `one data object per week WITH ROWS, got: ${data.join(", ")}`);
  for (const week of DATA_WEEKS) {
    assert.ok(
      data.includes(`archive/test/widget_logs/${week.year}/test-widget_logs-${week.label}-p001.ndjson.zst`),
      `expected a data object for ${week.label}, got: ${data.join(", ")}`,
    );
  }
  // The empty week gets a manifest but NO data object — that is how a gap stays explained.
  assert.equal(manifests.length, 4, `a manifest per ELIGIBLE week incl. the empty one, got: ${manifests.join(", ")}`);
  const emptyManifestKey = `archive/test/widget_logs/${EMPTY_WEEK.year}/test-widget_logs-${EMPTY_WEEK.label}-p001.manifest.json`;
  assert.ok(manifests.includes(emptyManifestKey), `expected a manifest for the empty ${EMPTY_WEEK.label}`);
  const emptyManifest = JSON.parse(readFileSync(join(storeDir, emptyManifestKey), "utf8"));
  assert.equal(emptyManifest.rowCount, 0);
  assert.equal(emptyManifest.objectKey, null, "an empty week must not claim a data object");
  assert.equal(emptyManifest.fingerprint.digest, "0000000000000000");

  const indexKeys = files.filter((f) => f.includes("/_index/"));
  assert.ok(indexKeys.length >= 1, `expected a per-year index, got: ${files.join(", ")}`);
  assert.equal(Number(psql(dbUrl(), "SELECT count(*) FROM public.widget_logs")), 13, "archiving must not delete");

  // ── the archived bytes really are the rows ───────────────────────────────
  const week0 = DATA_WEEKS[0];
  const key = `archive/test/widget_logs/${week0.year}/test-widget_logs-${week0.label}-p001.ndjson.zst`;
  const ndjson = execFileSync("zstd", ["-d", "-c", join(storeDir, key)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows = ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.length, 4, "one line per row, despite payloads containing escaped newlines and 300 KB bodies");

  const live = psql(
    dbUrl(),
    `SELECT id::text || E'\\t' || coalesce(md5(payload), '') FROM public.widget_logs
     WHERE created_at >= '${week0.start.toISOString()}'::timestamptz
       AND created_at < '${week0.end.toISOString()}'::timestamptz ORDER BY id`,
  )
    .split("\n")
    .map((l) => l.split("\t"));
  const archived = rows
    .map((r) => [String(r.id), r.payload === null ? "" : md5(String(r.payload))])
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(archived, live, "every id and payload must survive the round trip byte-for-byte");

  // The manifest's fingerprint must agree with one computed independently in Node.
  const manifest = JSON.parse(
    readFileSync(join(storeDir, key.replace(".ndjson.zst", ".manifest.json")), "utf8"),
  );
  assert.equal(manifest.rowCount, 4);
  assert.equal(manifest.week, week0.label);
  assert.equal(manifest.fingerprint.digest, xorDigest(rows.map((r) => String(r.id))), "Postgres bit_xor === Node xorDigest");
  assert.equal(manifest.objectKey, key);
  assert.equal(isoWeekOf(new Date(manifest.windowStart)).label, week0.label);

  // ── re-running archive is an idempotent no-op ────────────────────────────
  runArchiver(profile, ["--mode", "archive", "--target", `local:${storeDir}`]);
  assert.deepEqual(listFiles(storeDir), files, "a second archive pass must not add or rewrite an object");

  // ── --dry-run=source prunes nothing ──────────────────────────────────────
  runArchiver(profile, ["--mode", "prune", "--target", `local:${storeDir}`, "--dry-run", "source"]);
  assert.equal(Number(psql(dbUrl(), "SELECT count(*) FROM public.widget_logs")), 13, "source dry run must not delete");

  // ── prune for real ───────────────────────────────────────────────────────
  runArchiver(profile, ["--mode", "prune", "--target", `local:${storeDir}`]);
  assert.equal(
    Number(psql(dbUrl(), "SELECT count(*) FROM public.widget_logs")),
    1,
    "exactly the 12 archived rows go; the current-week row stays",
  );
  assert.equal(psql(dbUrl(), "SELECT service FROM public.widget_logs"), "current");

  const states = indexKeys
    .flatMap((k) => readFileSync(join(storeDir, k), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(states.length, 4, "all four eligible weeks are tracked");
  assert.ok(states.every((s) => s.state === "pruned"), "every archived week is now marked pruned");

  // ── and a further run has nothing left to do ─────────────────────────────
  const after = runArchiver(profile, ["--target", `local:${storeDir}`]);
  assert.deepEqual(listFiles(storeDir), files, "steady state: no new objects");
  assert.match(after, /done in/);
});

// ── The encryption leg ───────────────────────────────────────────────────────
// The archive's whole confidentiality story is that CI holds only a PUBLIC age recipient, so a
// leaked CI credential cannot read a single archived row. That only holds if the object really is
// age-encrypted to that recipient and really decrypts with the offline identity — which is what
// this proves, using a throwaway keypair generated in the test.

const ageSkip = skip || (existsSync("/usr/local/bin/age") || existsSync("/opt/homebrew/bin/age") ? false : "age CLI not installed");

test("archive with encryption: age is unreadable without the identity, and exact with it", { skip: ageSkip }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "gf-archive-age-"));
  const storeDir = join(work, "store");
  t.after(() => {
    try {
      psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    } catch {
      /* best effort */
    }
    rmSync(work, { recursive: true, force: true });
  });

  // A throwaway identity. In production this half never exists in CI at all.
  const identityPath = join(work, "identity.txt");
  const keygen = execFileSync("age-keygen", ["-o", identityPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const recipient = /(age1[0-9a-z]+)/.exec(`${keygen}\n${readFileSync(identityPath, "utf8")}`)?.[1];
  assert.ok(recipient, "age-keygen must yield a public recipient");

  seed();
  const profile = writeProfile(work, "age");
  runArchiver(profile, ["--mode", "archive", "--target", `local:${storeDir}`], {
    AGE_ARCHIVE_RECIPIENT: recipient!,
  });

  const week0 = DATA_WEEKS[0];
  const key = `archive/test/widget_logs/${week0.year}/test-widget_logs-${week0.label}-p001.ndjson.zst.age`;
  const objPath = join(storeDir, key);
  assert.ok(existsSync(objPath), `expected an .age object, got: ${listFiles(storeDir).join(", ")}`);

  // It really is opaque: the plaintext carries service names, and age's own header must be present.
  const raw = readFileSync(objPath);
  assert.match(raw.subarray(0, 64).toString("binary"), /^age-encryption\.org/, "must be a real age file");
  assert.ok(!raw.includes(Buffer.from("svc0")), "no plaintext column value may survive into the object");

  // And exact with the identity: decrypt → decompress → compare against the live rows.
  const plain = execFileSync("sh", ["-c", `age -d -i '${identityPath}' '${objPath}' | zstd -d -c`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows = plain.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.length, 4);

  const manifest = JSON.parse(readFileSync(join(storeDir, key.replace(".ndjson.zst.age", ".manifest.json")), "utf8"));
  assert.equal(manifest.encryption.scheme, "age");
  assert.equal(manifest.encryption.recipient, recipient);
  assert.equal(manifest.fingerprint.digest, xorDigest(rows.map((r) => String(r.id))));

  const liveIds = psql(
    dbUrl(),
    `SELECT id::text FROM public.widget_logs
     WHERE created_at >= '${week0.start.toISOString()}'::timestamptz
       AND created_at < '${week0.end.toISOString()}'::timestamptz ORDER BY id`,
  ).split("\n");
  assert.deepEqual(rows.map((r) => String(r.id)).sort(), liveIds.sort(), "decrypted ids must equal the live rows");
});

// ── Recovery + the anomaly path ──────────────────────────────────────────────
// Both were covered only by unit tests on the state machine; these drive the real script.

/** runArchiver, but tolerating (and returning) a non-zero exit — the anomaly path exits 1 by design. */
function runArchiverAllowFail(profile: string, args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: runArchiver(profile, args) };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

test("--rebuild-index reconstructs a lost index and reconciles pruned weeks", { skip }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "gf-archive-rebuild-"));
  const storeDir = join(work, "store");
  t.after(() => {
    try {
      psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    } catch {
      /* best effort */
    }
    rmSync(work, { recursive: true, force: true });
  });

  seed();
  const profile = writeProfile(work);
  runArchiver(profile, ["--target", `local:${storeDir}`]); // archive + prune
  assert.equal(Number(psql(dbUrl(), "SELECT count(*) FROM public.widget_logs")), 1);

  const indexKey = listFiles(storeDir).find((f) => f.includes("/_index/"))!;
  const before = readFileSync(join(storeDir, indexKey), "utf8");
  rmSync(join(storeDir, indexKey)); // lose the derived cache
  assert.ok(!listFiles(storeDir).some((f) => f.includes("/_index/")));

  runArchiver(profile, ["--rebuild-index", "--target", `local:${storeDir}`]);
  const after = readFileSync(join(storeDir, indexKey), "utf8");
  const states = after.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(states.length, 4, "every week is recovered from its manifest alone");
  for (const week of DATA_WEEKS) {
    const rec = states.find((s) => s.label === week.label);
    assert.equal(rec.state, "pruned", `${week.label}: archive has rows, table does not ⇒ pruned`);
  }
  assert.equal(
    states.find((s) => s.label === EMPTY_WEEK.label).state,
    "archived",
    "a genuinely empty week has nothing to reconcile and stays archived",
  );
  assert.deepEqual(
    states.map((s) => s.label).sort(),
    before.split("\n").filter(Boolean).map((l) => JSON.parse(l).label).sort(),
    "the rebuilt index covers exactly the same weeks",
  );

  // …and the recovered index is USABLE: a following run must be a quiet no-op, not a wall of refusals.
  const follow = runArchiverAllowFail(profile, ["--target", `local:${storeDir}`]);
  assert.equal(follow.code, 0, `a run after --rebuild-index must succeed, got:\n${follow.out}`);
  assert.doesNotMatch(follow.out, /REFUSED/);
});

test("a row back-dated into an already-pruned week becomes a supplement, and pages", { skip }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "gf-archive-anomaly-"));
  const storeDir = join(work, "store");
  t.after(() => {
    try {
      psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    } catch {
      /* best effort */
    }
    rmSync(work, { recursive: true, force: true });
  });

  seed();
  const profile = writeProfile(work);
  runArchiver(profile, ["--target", `local:${storeDir}`]);
  const week = DATA_WEEKS[1];
  const p1 = `archive/test/widget_logs/${week.year}/test-widget_logs-${week.label}-p001.ndjson.zst`;
  assert.ok(listFiles(storeDir).includes(p1));

  // The thing that "cannot happen": a row lands inside a window that was already archived AND pruned.
  const ts = new Date(week.start.getTime() + 5 * 3_600_000).toISOString();
  psql(
    dbUrl(),
    `INSERT INTO public.widget_logs (created_at, service, payload) VALUES ('${ts}'::timestamptz,'late','arrived late')`,
  );

  const res = runArchiverAllowFail(profile, ["--target", `local:${storeDir}`]);
  assert.equal(res.code, 1, "an anomaly must page, not pass quietly");
  assert.match(res.out, /ALREADY-PRUNED/);
  assert.match(res.out, new RegExp(week.label));

  // The original part is untouched; the late row lands in a NEW additive part.
  const p2 = `archive/test/widget_logs/${week.year}/test-widget_logs-${week.label}-p002.ndjson.zst`;
  const files = listFiles(storeDir);
  assert.ok(files.includes(p1), "the original part must never be rewritten");
  assert.ok(files.includes(p2), `expected a supplement part, got: ${files.join(", ")}`);

  const supplement = JSON.parse(
    readFileSync(join(storeDir, p2.replace(".ndjson.zst", ".manifest.json")), "utf8"),
  );
  assert.equal(supplement.role, "supplement");
  assert.equal(supplement.anomaly, true);
  assert.equal(supplement.rowCount, 1, "the supplement holds ONLY the late row");

  const rows = execFileSync("zstd", ["-d", "-c", join(storeDir, p2)], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].service, "late");
});

test("the R2 store path runs end to end via an rclone alias backend (no credentials)", { skip }, async (t) => {
  // R2Store is the one substantial surface the local sink never touches: rclone lsf/copyto/cat, the
  // staged-file putText (rcat does NOT work against R2), the exists() parent-listing trick, and the
  // run-log append. Pointing ARCHIVE_RCLONE_REMOTE at an `alias` backend exercises every one of those
  // code paths against a directory. It is NOT a substitute for a real R2 run — S3 signatures and
  // empty-prefix semantics still differ — but it is the difference between "never executed" and
  // "executed, just not against Cloudflare". Note a missing prefix ERRORS on a filesystem backend,
  // so this drives the defensive reachable() fallback rather than S3's easy empty-listing path.
  const dir = mkdtempSync(join(tmpdir(), "gf-archive-r2-"));
  const bucketDir = join(dir, "archivebucket");
  mkdirSync(bucketDir, { recursive: true }); // the bucket itself exists, as it would on R2
  // runlog.ts lists the log directory before appending, and on a filesystem backend a MISSING
  // directory is an error — so it would (correctly, for its own clobber-guard) skip the append.
  // On S3/R2 that listing returns empty and succeeds, which is how each new month is created in
  // production. Pre-create it so the alias backend models the object store. R2Store needs no such
  // help: its list() falls back to probing the bucket root to tell "empty" from "unreachable".
  mkdirSync(join(bucketDir, "_log", "test"), { recursive: true });
  t.after(() => {
    try {
      psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  seed();
  const profile = writeProfile(dir);
  const r2Env = {
    ARCHIVE_RCLONE_REMOTE: "lt",
    RUNLOG_RCLONE_REMOTE: "lt",
    RCLONE_CONFIG_LT_TYPE: "alias",
    RCLONE_CONFIG_LT_REMOTE: dir,
    R2_BUCKET: "archivebucket",
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
  };

  // --target defaults to r2, so this is the production code path.
  runArchiver(profile, ["--mode", "archive"], r2Env);

  const written = listFiles(bucketDir);
  const data = written.filter((f) => f.endsWith(".ndjson.zst"));
  assert.equal(data.length, 3, `objects must land in the bucket, got: ${written.join(", ")}`);
  assert.equal(written.filter((f) => f.endsWith(".manifest.json")).length, 4, "manifests too (staged copyto)");
  assert.ok(
    written.some((f) => f.startsWith("archive/test/widget_logs/_index/")),
    "and the derived index (putTextOverwrite)",
  );
  // verify-after-upload re-downloads and re-hashes, so reaching here means fetchToFile worked.

  // The run-log record lands, through the same append emulation the dashboard will later read.
  const logLine = written.find((f) => f.startsWith("_log/test/archives-"));
  assert.ok(logLine, `expected a run-log record, got: ${written.join(", ")}`);
  const rec = JSON.parse(readFileSync(join(bucketDir, logLine!), "utf8").trim());
  assert.equal(rec.table, "public.widget_logs");
  assert.equal(rec.weeksArchived, 4);
  assert.equal(rec.rowsArchived, 12);
  assert.equal(rec.weeksPruned, 0, "this was --mode archive");
  assert.ok(rec.bytes > 0);

  // A second archive pass must be a no-op — proving exists() reads the bucket correctly rather
  // than blindly re-writing (which would also hit the never-overwrite guard).
  runArchiver(profile, ["--mode", "archive"], r2Env);
  assert.equal(listFiles(bucketDir).filter((f) => f.endsWith(".ndjson.zst")).length, 3, "no duplicate objects");

  // And prune, gated on a fingerprint read back from the bucket's manifests.
  runArchiver(profile, ["--mode", "prune"], r2Env);
  assert.equal(Number(psql(dbUrl(), "SELECT count(*) FROM public.widget_logs")), 1, "exactly the archived rows go");
});
