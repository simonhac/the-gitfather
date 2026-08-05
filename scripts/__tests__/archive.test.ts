import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isoWeekOf,
  isoWeek,
  parseWeekLabel,
  isWeekEligible,
  eligibleWeeks,
  archiveObjectKey,
  manifestObjectKey,
  indexObjectKey,
  emptyFingerprint,
  xorDigest,
  fingerprintOf,
  planArchive,
  planPrune,
  parsePruneManifest,
  activePart,
  fingerprintSql,
  extractSql,
  deleteBatchSql,
  oldestRowSql,
  anomalousWeeksSql,
  parseDryRun,
  guardsFor,
  WEEK_MS,
} from "../lib/archive.js";

const utc = (s: string) => new Date(`${s}T00:00:00Z`);

// ── ISO week math ────────────────────────────────────────────────────────────
// ISO 8601: weeks start Monday; week 1 is the week containing 4 January (equivalently,
// the first week with a Thursday in it). The week-numbering YEAR is therefore not always
// the calendar year of the week's days — which is exactly what the folder layout keys on.

test("isoWeekOf: a plain mid-year week", () => {
  const w = isoWeekOf(utc("2026-07-31")); // a Friday
  assert.equal(w.label, "2026-W31");
  assert.equal(w.year, 2026);
  assert.equal(w.week, 31);
  assert.equal(w.start.toISOString(), "2026-07-27T00:00:00.000Z"); // Monday
  assert.equal(w.end.toISOString(), "2026-08-03T00:00:00.000Z"); // exclusive — next Monday
});

test("isoWeekOf: the window is half-open [start, end)", () => {
  const w = isoWeekOf(utc("2026-07-31"));
  assert.equal(isoWeekOf(w.start).label, "2026-W31", "start belongs to the week");
  assert.equal(isoWeekOf(w.end).label, "2026-W32", "end belongs to the NEXT week");
  assert.equal(w.end.getTime() - w.start.getTime(), WEEK_MS);
});

test("isoWeekOf: December days can belong to the NEXT year's week 01", () => {
  // 2026-01-01 is a Thursday, so ISO week 1 of 2026 runs Mon 2025-12-29 → Sun 2026-01-04.
  const w = isoWeekOf(utc("2025-12-29"));
  assert.equal(w.label, "2026-W01");
  assert.equal(w.year, 2026, "the week-numbering year, not the calendar year");
  assert.equal(w.start.toISOString(), "2025-12-29T00:00:00.000Z");
});

test("isoWeekOf: the day before that is still 2025-W52", () => {
  assert.equal(isoWeekOf(utc("2025-12-28")).label, "2025-W52");
});

test("isoWeekOf: January days can belong to the PREVIOUS year's week 53", () => {
  // 2026 starts on a Thursday, so it is a 53-week ISO year: W53 runs Mon 2026-12-28 → Sun 2027-01-03.
  assert.equal(isoWeekOf(utc("2026-12-28")).label, "2026-W53");
  assert.equal(isoWeekOf(utc("2027-01-03")).label, "2026-W53");
  assert.equal(isoWeekOf(utc("2027-01-04")).label, "2027-W01");
});

test("isoWeek: constructing by (year, week) round-trips through isoWeekOf", () => {
  for (const [y, n] of [
    [2026, 1],
    [2026, 31],
    [2026, 53],
    [2027, 1],
    [2025, 52],
  ] as const) {
    const w = isoWeek(y, n);
    assert.equal(w.label, `${y}-W${String(n).padStart(2, "0")}`);
    assert.equal(isoWeekOf(w.start).label, w.label, `${w.label}: start round-trips`);
    assert.equal(
      isoWeekOf(new Date(w.end.getTime() - 1)).label,
      w.label,
      `${w.label}: last instant round-trips`,
    );
  }
});

test("parseWeekLabel: accepts a well-formed label, rejects junk", () => {
  assert.equal(parseWeekLabel("2026-W07").week, 7);
  assert.equal(parseWeekLabel("2026-W07").year, 2026);
  for (const bad of ["", "2026-W", "2026W07", "2026-w07", "2026-W7", "2026-W00", "2026-W54", "nope"]) {
    assert.throws(() => parseWeekLabel(bad), /invalid ISO week label/, `should reject "${bad}"`);
  }
});

test("parseWeekLabel: rejects W53 in a 52-week ISO year", () => {
  // 2025 starts on a Wednesday and is not a leap year → 52 ISO weeks.
  assert.throws(() => parseWeekLabel("2025-W53"), /invalid ISO week label/);
  assert.equal(parseWeekLabel("2026-W53").week, 53, "but 2026 really does have a week 53");
});

// ── Eligibility ──────────────────────────────────────────────────────────────
// "Older than N weeks" is read strictly: EVERY row in an eligible week must be at least
// N weeks old, so the test is on the week's END, not its start.

test("isWeekEligible: a week is eligible only once its END is N weeks behind now", () => {
  const now = utc("2026-07-31");
  assert.equal(isWeekEligible(isoWeek(2026, 26), now, 4), true, "W26 ended 2026-06-29, +28d = 07-27 ≤ now");
  assert.equal(isWeekEligible(isoWeek(2026, 27), now, 4), false, "W27 ended 2026-07-06, +28d = 08-03 > now");
  assert.equal(isWeekEligible(isoWeek(2026, 31), now, 4), false, "the current week is never eligible");
});

test("isWeekEligible: every row in an eligible week is genuinely ≥ N weeks old", () => {
  const now = utc("2026-07-31");
  const w = isoWeek(2026, 26);
  const newestRowInstant = w.end.getTime() - 1;
  assert.ok(now.getTime() - newestRowInstant >= 4 * WEEK_MS);
});

test("isWeekEligible: afterWeeks=0 still excludes the in-progress week", () => {
  const now = utc("2026-07-31");
  assert.equal(isWeekEligible(isoWeek(2026, 31), now, 0), false);
  assert.equal(isWeekEligible(isoWeek(2026, 30), now, 0), true);
});

test("eligibleWeeks: walks oldest→newest, caps at maxWeeks, skips already-done labels", () => {
  const now = utc("2026-07-31");
  const all = eligibleWeeks({
    now,
    oldestRowAt: utc("2026-06-03"), // inside 2026-W23
    afterWeeks: 4,
    maxWeeks: 100,
    done: new Set(),
  });
  assert.deepEqual(
    all.map((w) => w.label),
    ["2026-W23", "2026-W24", "2026-W25", "2026-W26"],
    "oldest first, stopping at the newest eligible week",
  );

  const capped = eligibleWeeks({ now, oldestRowAt: utc("2026-06-03"), afterWeeks: 4, maxWeeks: 2, done: new Set() });
  assert.deepEqual(capped.map((w) => w.label), ["2026-W23", "2026-W24"], "cap takes the OLDEST first");

  const resumed = eligibleWeeks({
    now,
    oldestRowAt: utc("2026-06-03"),
    afterWeeks: 4,
    maxWeeks: 100,
    done: new Set(["2026-W23", "2026-W25"]),
  });
  assert.deepEqual(resumed.map((w) => w.label), ["2026-W24", "2026-W26"], "already-archived weeks are skipped");
});

test("eligibleWeeks: no rows → nothing to do", () => {
  const weeks = eligibleWeeks({
    now: utc("2026-07-31"),
    oldestRowAt: null,
    afterWeeks: 4,
    maxWeeks: 100,
    done: new Set(),
  });
  assert.deepEqual(weeks, []);
});

test("eligibleWeeks: crosses a year boundary without a gap or a duplicate", () => {
  // 2026 is a 53-week ISO year, so the walk must step W52 → W53 → 2027-W01 without inventing
  // a "2026-W54" or skipping straight to 2027. At this `now`, W01 has just become eligible
  // (it ended 2027-01-11, four weeks earlier to the day) and W02 has not.
  const weeks = eligibleWeeks({
    now: utc("2027-02-08"),
    oldestRowAt: utc("2026-12-20"), // 2026-W51
    afterWeeks: 4,
    maxWeeks: 100,
    done: new Set(),
  });
  assert.deepEqual(weeks.map((w) => w.label), ["2026-W51", "2026-W52", "2026-W53", "2027-W01"]);
  // …and the windows tile exactly, no overlap, no hole.
  for (let i = 1; i < weeks.length; i++) {
    assert.equal(weeks[i].start.getTime(), weeks[i - 1].end.getTime(), `${weeks[i].label} abuts its predecessor`);
  }
});

// ── Object keys ──────────────────────────────────────────────────────────────

test("archiveObjectKey: a folder per year, a file per week, part-numbered", () => {
  const w = isoWeek(2026, 23);
  assert.equal(
    archiveObjectKey({ prefix: "archive/boost", name: "boost", table: "api_logs", week: w, part: 1, ext: "ndjson.zst.age" }),
    "archive/boost/api_logs/2026/boost-api_logs-2026-W23-p001.ndjson.zst.age",
  );
  assert.equal(
    manifestObjectKey({ prefix: "archive/boost", name: "boost", table: "api_logs", week: w, part: 2 }),
    "archive/boost/api_logs/2026/boost-api_logs-2026-W23-p002.manifest.json",
  );
});

test("archiveObjectKey: the folder follows the ISO week-numbering year, not the calendar year", () => {
  // 2026-W01 contains 2025-12-29..31 but files under 2026/ — label and folder can never disagree.
  const w = isoWeek(2026, 1);
  assert.equal(w.start.getUTCFullYear(), 2025, "the week really does start in 2025");
  assert.match(
    archiveObjectKey({ prefix: "archive/boost", name: "boost", table: "api_logs", week: w, part: 1, ext: "ndjson.zst.age" }),
    /\/2026\/boost-api_logs-2026-W01-p001\./,
  );
});

test("archiveObjectKey: tolerates a prefix written with stray slashes", () => {
  const w = isoWeek(2026, 23);
  const key = archiveObjectKey({ prefix: "/archive/boost/", name: "boost", table: "api_logs", week: w, part: 1, ext: "ndjson" });
  assert.equal(key, "archive/boost/api_logs/2026/boost-api_logs-2026-W23-p001.ndjson");
});

test("indexObjectKey: the derived index is per table+year, OUTSIDE any locked data prefix", () => {
  assert.equal(
    indexObjectKey({ prefix: "archive/boost", table: "api_logs", year: 2026 }),
    "archive/boost/api_logs/_index/api_logs-2026.jsonl",
  );
});

// ── Set fingerprint ──────────────────────────────────────────────────────────
// count + an order-independent 64-bit XOR of md5(id). Must agree with the SQL
// `bit_xor(('x'||substr(md5(id::text),1,16))::bit(64))` computed on the live table.

const ID_A = "00000000-0000-0000-0000-000000000001";
const ID_B = "11111111-2222-3333-4444-555555555555";
const ID_C = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

test("xorDigest: golden values (must match Postgres md5/bit_xor)", () => {
  assert.equal(xorDigest([ID_A]), "c96589eefb0828c0");
  assert.equal(xorDigest([ID_B]), "c6426b96020dfc0c");
  assert.equal(xorDigest([ID_C]), "83236d741418daf5");
  assert.equal(xorDigest([ID_A, ID_B]), "0f27e278f905d4cc");
  assert.equal(xorDigest([ID_A, ID_B, ID_C]), "8c048f0ced1d0e39");
});

test("xorDigest: order-independent — that is the whole point", () => {
  assert.equal(xorDigest([ID_C, ID_A, ID_B]), xorDigest([ID_A, ID_B, ID_C]));
});

test("xorDigest: always 16 lowercase hex chars, zero-padded", () => {
  const d = xorDigest([ID_A]);
  assert.match(d, /^[0-9a-f]{16}$/);
  assert.equal(emptyFingerprint().digest, "0000000000000000");
  assert.equal(emptyFingerprint().n, 0);
});

test("fingerprintOf: reads NDJSON, counts rows and digests ids", () => {
  const ndjson =
    [
      JSON.stringify({ id: ID_A, service: "xero" }),
      JSON.stringify({ id: ID_B, service: "together" }),
      JSON.stringify({ id: ID_C, service: "slack" }),
    ].join("\n") + "\n";
  const fp = fingerprintOf(ndjson);
  assert.equal(fp.n, 3);
  assert.equal(fp.digest, "8c048f0ced1d0e39");
});

test("fingerprintOf: id is found even when it is NOT the first key", () => {
  // The fast path keys on `{"id":"…"` because to_jsonb follows column order; the fallback
  // must still be correct if a table ever puts id elsewhere.
  const ndjson = [JSON.stringify({ service: "xero", id: ID_A }), JSON.stringify({ id: ID_B })].join("\n") + "\n";
  assert.equal(fingerprintOf(ndjson).digest, xorDigest([ID_A, ID_B]));
});

test("fingerprintOf: tolerates a missing trailing newline and blank lines", () => {
  assert.equal(fingerprintOf(`${JSON.stringify({ id: ID_A })}`).n, 1);
  assert.equal(fingerprintOf(`${JSON.stringify({ id: ID_A })}\n\n`).n, 1);
  assert.equal(fingerprintOf("").n, 0);
  assert.equal(fingerprintOf("\n").n, 0);
});

test("fingerprintOf: survives bodies containing braces, quotes and escaped newlines", () => {
  // api_logs rows carry raw webhook bodies; a naive line/regex scanner would trip on these.
  const nasty = {
    id: ID_A,
    request_body: '{"nested":"{\\"deep\\":1}"}\nnot-a-new-row',
    response_body: 'back\\slash and a "quote"',
  };
  const fp = fingerprintOf(JSON.stringify(nasty) + "\n");
  assert.equal(fp.n, 1, "the escaped newline must NOT split the row");
  assert.equal(fp.digest, xorDigest([ID_A]));
});

test("fingerprintOf: a truncated final line is a hard error, never a silent short count", () => {
  // This is the CB-194 failure class: a stream that dies mid-row must not read as success.
  const good = JSON.stringify({ id: ID_A });
  assert.throws(() => fingerprintOf(`${good}\n{"id":"11111111-`), /malformed NDJSON/);
});

test("fingerprintSql: targets the window half-open and needs no ordering", () => {
  const sql = fingerprintSql("public.api_logs", "created_at");
  assert.match(sql, /bit_xor/);
  assert.match(sql, /created_at >= /);
  assert.match(sql, /created_at < /);
  assert.doesNotMatch(sql, /order by/i, "an order-independent digest must not need a sort");
  assert.match(sql, /lpad\(/, "digest must be zero-padded to 16 hex chars like the Node side");
});

test("extractSql: streams through a cursor, read-only, over a half-open window", () => {
  const sql = extractSql("public.api_logs", "created_at");
  assert.match(sql, /\\set FETCH_COUNT 1000/, "must stream, not materialise the whole window");
  assert.match(sql, /\\pset format unaligned/);
  assert.match(sql, /\\pset tuples_only on/);
  assert.match(sql, /SET default_transaction_read_only = on;/, "the extract session must be provably read-only");
  assert.match(sql, /created_at >= :'start'::timestamptz AND created_at < :'end'::timestamptz/);
  assert.match(sql, /to_jsonb\(t\)::text/);
  assert.doesNotMatch(sql, /COPY/i, "COPY's backslash escaping would corrupt NDJSON round-trips");
});

test("extractSql: never interpolates a timestamp into the SQL text", () => {
  const sql = extractSql("public.api_logs", "created_at");
  assert.doesNotMatch(sql, /\d{4}-\d{2}-\d{2}/, "dates must arrive as bound psql variables");
});

test("deleteBatchSql: an id-list delete with a LIMIT, never a bare predicate delete", () => {
  const sql = deleteBatchSql("public.api_logs", "created_at", 2000);
  assert.match(sql, /LIMIT 2000/);
  assert.match(sql, /USING victims v WHERE t\.id = v\.id/, "deletes an explicit id set");
  assert.match(sql, /created_at >= :'start'::timestamptz AND created_at < :'end'::timestamptz/);
  assert.match(sql, /SELECT count\(\*\)::text FROM deleted/, "must report how many rows it actually removed");
  // A predicate delete would re-evaluate the window each pass and could sweep in rows that landed
  // after the fingerprint gate ran.
  assert.doesNotMatch(sql, /DELETE FROM public\.api_logs\s+WHERE/i);
});

test("extractSql: the read-only SET's command tag is kept out of the NDJSON stream", () => {
  const sql = extractSql("public.api_logs", "created_at");
  const lines = sql.split("\n");
  const setAt = lines.findIndex((l) => l.includes("default_transaction_read_only"));
  assert.ok(setAt > 0);
  assert.equal(lines[setAt - 1], "\\o /dev/null", "output is redirected before the SET");
  assert.equal(lines[setAt + 1], "\\o", "and restored immediately after");
});

test("anomalousWeeksSql: finds weeks behind the watermark in ONE query, using ISO week codes", () => {
  const sql = anomalousWeeksSql("public.api_logs", "created_at");
  assert.match(sql, /'IYYY-"W"IW'/, "Postgres ISO week codes must match our own labelling");
  assert.match(sql, /AT TIME ZONE 'UTC'/, "otherwise the server's timezone would pick the boundaries");
  assert.match(sql, /created_at < :'watermark'::timestamptz/);
  assert.match(sql, /SELECT DISTINCT/);
});

test("oldestRowSql: returns an empty string for an empty table, not NULL", () => {
  const sql = oldestRowSql("public.api_logs", "created_at");
  assert.match(sql, /min\(created_at\)/);
  assert.match(sql, /coalesce\(/, "psql -tA prints NULL as empty anyway; be explicit about it");
  assert.match(sql, /AT TIME ZONE 'UTC'/, "week math is UTC — never hand the client a local-time stamp");
});

// ── Dry-run levels ───────────────────────────────────────────────────────────

test("parseDryRun: the three levels, and nothing else", () => {
  assert.equal(parseDryRun(undefined), "none");
  assert.equal(parseDryRun("none"), "none");
  assert.equal(parseDryRun("source"), "source");
  assert.equal(parseDryRun("store"), "store");
  for (const bad of ["", "yes", "true", "db", "all", "SOURCE"]) {
    assert.throws(() => parseDryRun(bad), /invalid --dry-run/, `should reject "${bad}"`);
  }
});

test("guardsFor: --dry-run=source keeps the source database read-only", () => {
  assert.deepEqual(guardsFor("source"), { mayWriteStore: true, mayDeleteRows: false });
});

test("guardsFor: --dry-run=store suppresses the store AND still cannot delete", () => {
  assert.deepEqual(guardsFor("store"), { mayWriteStore: false, mayDeleteRows: false });
});

test("guardsFor: no level can ever delete rows without being allowed to write the store", () => {
  // The invariant the whole safety story rests on: deleting rows that were never stored is the
  // one unrecoverable failure, so "may delete" must imply "may write".
  for (const level of ["none", "source", "store"] as const) {
    const g = guardsFor(level);
    assert.ok(!g.mayDeleteRows || g.mayWriteStore, `${level} must not delete without writing`);
  }
  assert.deepEqual(guardsFor("none"), { mayWriteStore: true, mayDeleteRows: true });
});

// ── Part / prune state machine ───────────────────────────────────────────────

const fp = (n: number, digest: string) => ({ n, digest });
const part = (n: number, role: "full" | "superseded" | "supplement", f: { n: number; digest: string }) => ({
  part: n,
  role,
  rowCount: f.n,
  fingerprint: f,
});

test("planArchive: an untouched week is archived as part 1", () => {
  const plan = planArchive(undefined, fp(10, "aaaa000000000000"));
  assert.deepEqual(plan, { action: "archive", part: 1, role: "full" });
});

test("planArchive: an eligible week with zero live rows still gets a manifest, so gaps are explained", () => {
  const plan = planArchive(undefined, emptyFingerprint());
  assert.deepEqual(plan, { action: "archive", part: 1, role: "full" });
});

test("planArchive: re-running before the prune is an idempotent no-op", () => {
  const state = { label: "2026-W23", state: "archived" as const, parts: [part(1, "full", fp(10, "aaaa000000000000"))] };
  assert.deepEqual(planArchive(state, fp(10, "aaaa000000000000")), { action: "skip", reason: "already archived" });
});

test("planArchive: rows changed between archive and prune → supersede the whole window", () => {
  const state = { label: "2026-W23", state: "archived" as const, parts: [part(1, "full", fp(10, "aaaa000000000000"))] };
  const plan = planArchive(state, fp(11, "bbbb000000000000"));
  assert.deepEqual(plan, { action: "supersede", part: 2, role: "full", supersedes: [1] });
});

test("planArchive: rows appearing AFTER the prune are a supplement, and are flagged anomalous", () => {
  const state = { label: "2026-W23", state: "pruned" as const, parts: [part(1, "full", fp(10, "aaaa000000000000"))] };
  const plan = planArchive(state, fp(2, "cccc000000000000"));
  assert.deepEqual(plan, { action: "supplement", part: 2, role: "supplement", anomaly: true });
});

test("planArchive: a pruned week with no live rows is the normal steady state", () => {
  const state = { label: "2026-W23", state: "pruned" as const, parts: [part(1, "full", fp(10, "aaaa000000000000"))] };
  assert.deepEqual(planArchive(state, emptyFingerprint()), { action: "skip", reason: "already pruned" });
});

test("planArchive: supplements stack — part numbers only ever go up", () => {
  const state = {
    label: "2026-W23",
    state: "pruned" as const,
    parts: [part(1, "full", fp(10, "aaaa000000000000")), part(2, "supplement", fp(2, "cccc000000000000"))],
  };
  const plan = planArchive(state, fp(1, "dddd000000000000"));
  assert.equal(plan.action, "supplement");
  assert.equal(plan.part, 3);
});

test("activePart: the superseding part wins; superseded parts are ignored", () => {
  const parts = [part(1, "superseded", fp(10, "aaaa000000000000")), part(2, "full", fp(11, "bbbb000000000000"))];
  assert.equal(activePart(parts)?.part, 2);
  assert.equal(activePart([])?.part, undefined);
});

test("planPrune: deletes only when the live set still matches the archived set", () => {
  const state = { label: "2026-W23", state: "archived" as const, parts: [part(1, "full", fp(10, "aaaa000000000000"))] };
  assert.deepEqual(planPrune(state, fp(10, "aaaa000000000000")), { action: "prune", expectRows: 10, part: 1 });
});

test("planPrune: REFUSES on any fingerprint drift — never a partial delete", () => {
  const state = { label: "2026-W23", state: "archived" as const, parts: [part(1, "full", fp(10, "aaaa000000000000"))] };
  const changedDigest = planPrune(state, fp(10, "ffff000000000000"));
  assert.equal(changedDigest.action, "refuse");
  assert.match(changedDigest.reason!, /digest/);

  const changedCount = planPrune(state, fp(11, "aaaa000000000000"));
  assert.equal(changedCount.action, "refuse");
  assert.match(changedCount.reason!, /row count/);
});

test("planPrune: refuses a week that was never archived — the whole point of deferred prune", () => {
  const plan = planPrune(undefined, fp(10, "aaaa000000000000"));
  assert.equal(plan.action, "refuse");
  assert.match(plan.reason!, /no archive/);
});

test("planPrune: an already-pruned week is a no-op, not a refusal", () => {
  const state = { label: "2026-W23", state: "pruned" as const, parts: [part(1, "full", fp(10, "aaaa000000000000"))] };
  assert.deepEqual(planPrune(state, emptyFingerprint()), { action: "skip", reason: "already pruned" });
});

test("planPrune: a zero-row week needs no delete but is still marked pruned", () => {
  const state = { label: "2026-W23", state: "archived" as const, parts: [part(1, "full", emptyFingerprint())] };
  assert.deepEqual(planPrune(state, emptyFingerprint()), { action: "prune", expectRows: 0, part: 1 });
});

// ── The stored-object half of the prune gate ─────────────────────────────────
// planPrune only compares the LIVE table against the manifest, which says nothing about whether
// the stored object is still intact. The object is hash-verified when it is written, but a week is
// pruned `prune-after-weeks - archive-after-weeks` later (9 weeks apart in Boost's profile), so in
// the steady state prune ALWAYS acts on an object last verified many runs ago. These cover the
// second half: re-read the object at prune time and refuse on any drift.

const MANIFEST = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    week: "2026-W23",
    part: 1,
    rowCount: 40,
    objectKey: "archive/boost/api_logs/2026/boost-api_logs-2026-W23-p001.ndjson.zst.age",
    objectSha256: "a".repeat(64),
    fingerprint: { n: 40, digest: "aaaa000000000000" },
    ...over,
  });

test("parsePruneManifest: yields the key and hash the gate needs", () => {
  const r = parsePruneManifest(MANIFEST(), 1);
  assert.equal("error" in r, false);
  assert.deepEqual(r, {
    objectKey: "archive/boost/api_logs/2026/boost-api_logs-2026-W23-p001.ndjson.zst.age",
    objectSha256: "a".repeat(64),
  });
});

test("parsePruneManifest: a MISSING manifest refuses — never 'nothing to check, go ahead'", () => {
  const r = parsePruneManifest(null, 1);
  assert.ok("error" in r && /manifest/i.test(r.error));
});

test("parsePruneManifest: unparseable or non-object manifests refuse", () => {
  for (const text of ["", "   ", "not json", "null", "[]", "42"]) {
    const r = parsePruneManifest(text, 1);
    assert.ok("error" in r, `should refuse: ${JSON.stringify(text)}`);
  }
});

test("parsePruneManifest: a manifest with no recorded hash refuses rather than skipping the check", () => {
  // A legacy manifest predating objectSha256 must block the delete, not silently waive it.
  const r = parsePruneManifest(MANIFEST({ objectSha256: undefined }), 1);
  assert.ok("error" in r && /objectSha256/.test(r.error));
  const blank = parsePruneManifest(MANIFEST({ objectSha256: "" }), 1);
  assert.ok("error" in blank);
});

test("parsePruneManifest: a manifest with no object key refuses", () => {
  const r = parsePruneManifest(MANIFEST({ objectKey: undefined }), 1);
  assert.ok("error" in r && /objectKey/.test(r.error));
});

test("parsePruneManifest: a manifest for a DIFFERENT part refuses — wrong object, wrong proof", () => {
  const r = parsePruneManifest(MANIFEST({ part: 2 }), 1);
  assert.ok("error" in r && /part/.test(r.error));
});

test("parsePruneManifest: a ZERO-ROW week has no object to verify, and deletes nothing anyway", () => {
  // archiveWeek writes no data object when live.n === 0 — objectKey/objectSha256 are null by design.
  const r = parsePruneManifest(MANIFEST({ rowCount: 0, objectKey: null, objectSha256: null }), 1);
  assert.deepEqual(r, { nothingToVerify: true });
});

test("parsePruneManifest: a NON-empty week that lost its key still refuses — the waiver is rowCount-gated", () => {
  // The dangerous shape: if "no key recorded" alone waived the check, a manifest that lost its key
  // would wave 40 rows through unverified. Only a genuinely empty week may skip it.
  const r = parsePruneManifest(MANIFEST({ rowCount: 40, objectKey: null, objectSha256: null }), 1);
  assert.ok("error" in r && /objectKey/.test(r.error));
});

test("parsePruneManifest: a zero-row week that DID write an object is still verified", () => {
  const r = parsePruneManifest(MANIFEST({ rowCount: 0 }), 1);
  assert.deepEqual(r, {
    objectKey: "archive/boost/api_logs/2026/boost-api_logs-2026-W23-p001.ndjson.zst.age",
    objectSha256: "a".repeat(64),
  });
});

test("parsePruneManifest: a manifest with no rowCount refuses", () => {
  const r = parsePruneManifest(MANIFEST({ rowCount: undefined }), 1);
  assert.ok("error" in r && /rowCount/.test(r.error));
});
