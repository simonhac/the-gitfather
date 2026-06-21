import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRestoredTables, stampToIso, extForEncryption, type TableProbe } from "../restore-drill-pg.js";

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
