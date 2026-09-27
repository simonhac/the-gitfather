import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampAlert,
  MAX_ALERT_TEXT,
  MAX_ALERTS,
  OUTCOME_PREFIX,
  outcomeKey,
  outcomeRunInfix,
  outcomeStamp,
  outcomeStartAfter,
  parseJobOutcome,
  parseOutcomeKey,
  type JobOutcome,
} from "../lib/jobOutcome.js";

// The per-run outcome record is the contract between a job (which writes it on the way out) and the
// scheduler Worker (which finds it by key and renders Slack from it). The Worker treats it as
// untrusted input — anyone holding the bucket's CI key can write one — so the parser is strict and
// these pin exactly what it refuses.

const record = (over: Partial<JobOutcome> = {}): JobOutcome => ({
  version: 1,
  source: "job",
  job: "backup",
  name: "boost",
  runId: "18000000001",
  runAttempt: 1,
  jobId: "52000000001",
  ok: true,
  exitCode: 0,
  startedAt: "2026-09-27T03:15:07.123Z",
  finishedAt: "2026-09-27T03:19:41.000Z",
  durationMs: 273_877,
  origin: "schedule",
  summary: { kind: "backup", tiers: ["intraday", "daily"], bytes: 123_456 },
  alerts: [],
  ...over,
});

/** Parse a record after a JSON round trip, with `patch` applied to the raw object. */
const parseWith = (patch: Record<string, unknown>, base: JobOutcome = record()) => parseJobOutcome(JSON.stringify({ ...base, ...patch }));

// ── keys ─────────────────────────────────────────────────────────────────────

test("outcomeStamp: compact UTC, second precision; '' for an unparseable instant", () => {
  assert.equal(outcomeStamp("2026-09-27T03:15:07.999Z"), "20260927T031507Z");
  assert.equal(outcomeStamp("2026-01-02T23:04:05+10:00"), "20260102T130405Z"); // normalised to UTC
  assert.equal(outcomeStamp("not a date"), "");
});

test("outcomeKey ↔ parseOutcomeKey round-trip, including names that contain '_'", () => {
  for (const name of ["boost", "my_db", "a_b_c", "live-one.v2", "x"]) {
    for (const job of ["backup", "durableVerify", "restoreDrill", "archive"] as const) {
      const key = outcomeKey({ startedAt: "2026-09-27T03:15:07Z", runId: "123", runAttempt: 2, job, name });
      assert.equal(key, `${OUTCOME_PREFIX}20260927T031507Z_123_2_${job}_${name}.json`);
      assert.deepEqual(parseOutcomeKey(key), { stamp: "20260927T031507Z", runId: "123", runAttempt: 2, job, name });
      assert.ok(key.includes(outcomeRunInfix("123", 2, job)), "the run infix locates a run's record without its name");
    }
  }
});

test("outcomeKey refuses an identity that cannot form a safe key", () => {
  const ok = { startedAt: "2026-09-27T03:15:07Z", runId: "123", runAttempt: 1, job: "backup" as const, name: "boost" };
  assert.doesNotThrow(() => outcomeKey(ok));
  for (const bad of [
    { startedAt: "nope" },
    { runId: "12a" },
    { runId: "" },
    { runAttempt: 0 },
    { runAttempt: 1.5 },
    { job: "dump" },
    { name: "" },
    { name: "../evil" },
    { name: "a/b" },
    { name: "_leading" },
    { name: "x".repeat(65) },
  ]) {
    assert.throws(() => outcomeKey({ ...ok, ...bad } as typeof ok), /cannot build an outcome key/, JSON.stringify(bad));
  }
});

test("parseOutcomeKey: anything else under the prefix → null", () => {
  const good = `${OUTCOME_PREFIX}20260927T031507Z_123_1_backup_boost.json`;
  assert.ok(parseOutcomeKey(good));
  for (const bad of [
    "_status/boost/2026-09-27.json", // a daily-row state object, not an outcome
    good.replace(".json", ".txt"),
    `${OUTCOME_PREFIX}20260927T031507Z_123_1_backup.json`, // no name
    `${OUTCOME_PREFIX}2026-09-27_123_1_backup_boost.json`, // bad stamp
    `${OUTCOME_PREFIX}20260927T031507Z_12x_1_backup_boost.json`,
    `${OUTCOME_PREFIX}20260927T031507Z_123_0_backup_boost.json`, // attempts start at 1
    `${OUTCOME_PREFIX}20260927T031507Z_123_1_dump_boost.json`,
    `${OUTCOME_PREFIX}20260927T031507Z_123_1_backup_bad name.json`,
  ]) {
    assert.equal(parseOutcomeKey(bad), null, bad);
  }
});

test("keys sort in time order, and outcomeStartAfter lists records started at or after its second", () => {
  const at = (iso: string, runId = "9") => outcomeKey({ startedAt: iso, runId, runAttempt: 1, job: "backup", name: "boost" });
  const keys = [at("2026-09-27T03:15:08Z"), at("2026-09-26T23:59:59Z"), at("2026-09-27T03:15:07Z"), at("2026-10-01T00:00:00Z")];
  const sorted = [...keys].sort();
  assert.deepEqual(sorted, [keys[1], keys[2], keys[0], keys[3]]);

  // `startAfter` is exclusive of the listing's start key, so it must sort just BEFORE the first
  // record of its own second, whatever run/job/name follows the stamp.
  const since = Date.parse("2026-09-27T03:15:07.600Z");
  const startAfter = outcomeStartAfter(since);
  assert.ok(startAfter < at("2026-09-27T03:15:07Z", "0"), "a record of the same second is listed");
  assert.ok(startAfter < at("2026-09-27T03:15:08Z"));
  assert.ok(startAfter > at("2026-09-27T03:15:06Z", "99999999999999999999"), "an earlier second is not");
  assert.ok(startAfter > at("2026-09-26T23:59:59Z"));
});

// ── the strict parser ────────────────────────────────────────────────────────

test("parseJobOutcome: a well-formed record round-trips exactly", () => {
  const r = record({ alerts: [{ severity: "warn", code: "credential_rotation", text: "R2 is 400 days old" }] });
  assert.deepEqual(parseJobOutcome(JSON.stringify(r)), r);
  // Every summary kind, and the nullable fields.
  const kinds: JobOutcome[] = [
    record({ job: "durableVerify", origin: null, summary: { kind: "durableVerify", objects: 46, hashes: 2, restores: 1 } }),
    record({ job: "restoreDrill", origin: null, summary: { kind: "restoreDrill", table: "public.things", count: 1200, ratio: 0.998, key: "intraday/boost-x.dump" } }),
    record({ job: "restoreDrill", origin: null, summary: { kind: "restoreDrill", table: "public.things", count: null, ratio: null, key: "k" } }),
    record({ job: "archive", origin: null, summary: { kind: "archive", dryRun: "none", tables: [{ table: "public.api_logs", weeksArchived: 1, rowsArchived: 9, weeksPruned: 0, rowsPruned: 0 }] } }),
    record({ summary: null, jobId: null, origin: null, ok: false, exitCode: 143 }),
    record({ source: "github", summary: null }),
  ];
  for (const k of kinds) assert.deepEqual(parseJobOutcome(JSON.stringify(k)), k, k.job);
});

test("parseJobOutcome: a non-numeric optional number reads as null rather than failing the record", () => {
  const s = parseWith({ summary: { kind: "backup", tiers: ["intraday"], bytes: "12" } })?.summary;
  assert.ok(s && s.kind === "backup");
  assert.equal(s.bytes, null);
});

test("parseJobOutcome: rejects anything off-shape (→ the Worker marks it invalid and posts nothing)", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["version", { version: 2 }],
    ["source", { source: "worker" }],
    ["job", { job: "dump" }],
    ["name with a separator", { name: "a/b" }],
    ["name empty", { name: "" }],
    ["runId not digits", { runId: "18e9" }],
    ["runId number", { runId: 18000000001 }],
    ["runAttempt 0", { runAttempt: 0 }],
    ["jobId not digits", { jobId: "abc" }],
    ["ok not boolean", { ok: "true" }],
    ["exitCode fractional", { exitCode: 1.5 }],
    ["startedAt junk", { startedAt: "yesterday" }],
    ["finishedAt missing", { finishedAt: undefined }],
    ["durationMs negative", { durationMs: -1 }],
    ["origin unknown", { origin: "cron" }],
    ["summary for another job", { summary: { kind: "durableVerify", objects: 1, hashes: 1, restores: 1 } }],
    ["summary tier with markup", { summary: { kind: "backup", tiers: ["<!here>"], bytes: 1 } }],
    ["summary not an object", { summary: "ok" }],
    ["alerts not an array", { alerts: {} }],
    ["too many alerts", { alerts: Array.from({ length: MAX_ALERTS + 1 }, () => ({ severity: "warn", code: "x", text: "y" })) }],
    ["alert text too long", { alerts: [{ severity: "page", code: "x", text: "y".repeat(MAX_ALERT_TEXT + 1) }] }],
    ["alert code with markup", { alerts: [{ severity: "page", code: "<!here>", text: "y" }] }],
    ["alert code uppercase", { alerts: [{ severity: "page", code: "Restore_Failed", text: "y" }] }],
    ["alert severity", { alerts: [{ severity: "info", code: "x", text: "y" }] }],
  ];
  for (const [why, patch] of cases) assert.equal(parseWith(patch), null, why);

  const durable = record({ job: "durableVerify", summary: { kind: "durableVerify", objects: 1, hashes: 1, restores: 1 } });
  assert.equal(parseWith({ summary: { kind: "durableVerify", objects: -1, hashes: 1, restores: 1 } }, durable), null, "negative count");
  const archive = record({ job: "archive", summary: { kind: "archive", dryRun: "none", tables: [] } });
  assert.equal(parseWith({ summary: { kind: "archive", dryRun: "none", tables: [{ table: "t", weeksArchived: 1.5, rowsArchived: 0, weeksPruned: 0, rowsPruned: 0 }] } }, archive), null);

  for (const raw of ["", "not json", "[]", "null", "42", JSON.stringify(record()).padEnd(256 * 1024 + 1, " ")]) {
    assert.equal(parseJobOutcome(raw), null, raw.slice(0, 20));
  }
});

// ── clampAlert ───────────────────────────────────────────────────────────────

test("clampAlert: forces any alert into what the parser accepts", () => {
  assert.deepEqual(clampAlert({ severity: "page", code: "auth-rejected", text: "t" }), { severity: "page", code: "auth_rejected", text: "t" });
  assert.equal(clampAlert({ severity: "page", code: "Bad Code!", text: "t" }).code, "bad_code_");
  assert.equal(clampAlert({ severity: "warn", code: "", text: "t" }).code, "unknown");
  assert.equal(clampAlert({ severity: "warn", code: "x".repeat(60), text: "t" }).code.length, 40);

  const long = clampAlert({ severity: "page", code: "restore_failed", text: "y".repeat(MAX_ALERT_TEXT + 500) });
  assert.equal(long.text.length, MAX_ALERT_TEXT);
  assert.ok(long.text.endsWith("…"));
  assert.equal(clampAlert({ severity: "page", code: "x", text: "short" }).text, "short");

  // The point of it: a clamped alert always survives the Worker's parse.
  const wild = [
    { severity: "page" as const, code: "Weird-Code With Spaces And More Than Forty Characters", text: "z".repeat(5000) },
    { severity: "warn" as const, code: "", text: "" },
  ];
  assert.ok(parseJobOutcome(JSON.stringify(record({ ok: false, exitCode: 1, alerts: wild.map(clampAlert) }))));
});
