import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRestoredTables, evalRowRatio, stampToIso, extForEncryption, type TableProbe } from "../restore-drill-pg.js";

test("extForEncryption maps the encryption mode to the object extension", () => {
  assert.equal(extForEncryption("none"), "dump");
  assert.equal(extForEncryption("age"), "dump.age");
  assert.equal(extForEncryption("aes-gcm"), "dump.enc");
});

test("stampToIso: compact key stamp → ISO-8601 (or null when absent)", () => {
  assert.equal(stampToIso("daily/example-20260619T160000Z.dump"), "2026-06-19T16:00:00Z");
  assert.equal(stampToIso("weekly/x-20251231T000000Z.dump.age"), "2025-12-31T00:00:00Z");
  assert.equal(stampToIso("no-stamp-here.dump"), null);
});

test("checkRestoredTables: present must EXIST (rows optional); nonempty must have ≥1 row", () => {
  const counts: Record<string, number> = { a: 5, empty: 0, c: 3 };
  const probe = (t: string): TableProbe => (t in counts ? { ok: true, count: counts[t] } : { ok: false, count: 0 });

  // present table with 0 rows PASSES (it exists); nonempty table with rows PASSES.
  assert.deepEqual(checkRestoredTables(["empty"], ["a"], probe), {
    ok: true,
    reason: null,
    counts: { empty: 0, a: 5 },
  });

  // a present table that is absent/unreadable FAILS (and the message reflects both possibilities).
  const missing = checkRestoredTables(["gone"], [], probe);
  assert.equal(missing.ok, false);
  assert.match(missing.reason!, /missing or unreadable/);

  // a nonempty table with 0 rows FAILS as empty/zero (NOT misreported as missing).
  const empty = checkRestoredTables([], ["empty"], probe);
  assert.equal(empty.ok, false);
  assert.match(empty.reason!, /empty\/zero/);

  // a nonempty table that is absent FAILS as missing/unreadable.
  const both = checkRestoredTables([], ["gone"], probe);
  assert.equal(both.ok, false);
  assert.match(both.reason!, /missing or unreadable/);
});

test("evalRowRatio: dump-time reference makes a table that grew since the dump a non-issue (the durable fix)", () => {
  // The real regression: by verify time the LIVE table had grown past the dump, so restored/live dipped
  // under the 0.95 floor and false-failed as "truncated or stale" (an artefact of the dump→verify lag).
  const live = evalRowRatio("message_log", 217475, 230484, 0.95, 2.0, "live");
  assert.equal(live.ok, false);
  assert.equal(live.ratio, 0.9436); // 217475/230484 = 0.94356 → rounds to 0.9436 (still < 0.95 → false-fails on live)
  assert.match(live.reason!, /truncated or stale/);
  assert.match(live.reason!, /live/);

  // Same restored count, but measured against the count recorded AT DUMP TIME (≈ what was dumped) → passes.
  const dumpTime = evalRowRatio("message_log", 217475, 217475, 0.95, 2.0, "dump-time");
  assert.equal(dumpTime.ok, true);
  assert.equal(dumpTime.ratio, 1);
  assert.equal(dumpTime.reason, null);
});

test("evalRowRatio: a real truncation still fails against the dump-time reference", () => {
  const r = evalRowRatio("message_log", 100000, 217475, 0.95, 2.0, "dump-time");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /truncated or stale/);
  assert.match(r.reason!, /dump-time/);
});

test("evalRowRatio: duplication trips the ceiling", () => {
  const r = evalRowRatio("t", 460000, 217475, 0.95, 2.0, "dump-time");
  assert.equal(r.ok, false);
  assert.match(r.reason!, /duplicated/);
});

test("evalRowRatio: a few rows added between the pre-dump count and the snapshot still passes", () => {
  const r = evalRowRatio("t", 217600, 217475, 0.95, 2.0, "dump-time");
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test("evalRowRatio: the floor is inclusive (restored == min×ref passes; one below fails)", () => {
  assert.equal(evalRowRatio("t", 190000, 200000, 0.95, 2.0, "live").ok, true);
  assert.equal(evalRowRatio("t", 189999, 200000, 0.95, 2.0, "live").ok, false);
});
