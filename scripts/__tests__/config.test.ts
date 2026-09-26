import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SLOT_MINUTES } from "../lib/backupTypes.js";
import {
  backupSchema,
  drillSchema,
  verifyDurableSchema,
  dashboardSchema,
  reportConfigError,
  joinObjectKey,
} from "../lib/config.js";

// Minimal valid nested profiles (config from YAML + credentials from env). Tests mutate one field at a time.
const r2 = { accountId: "acct", bucket: "my-bucket", accessKeyId: "k", secretAccessKey: "s" };
const backupBase = {
  name: "example",
  backupPrefix: "pg/example",
  credentials: { databaseUrl: "postgres://u:p@h:5432/db?sslmode=require", r2 },
};
const drillBase = {
  name: "example",
  backupPrefix: "pg/example",
  drill: { rowCountTable: "public.things" },
  credentials: {
    drillDatabaseUrl: "postgresql://u:p@h:5432/drill",
    liveDatabaseUrl: "postgres://u:p@h:5432/live",
    r2,
  },
};

// ── Defaults & coercion ──────────────────────────────────────────────────────

test("backup: defaults applied for an otherwise-minimal config", () => {
  const r = backupSchema.safeParse(backupBase);
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.equal(r.data.encryption, "none");
  assert.equal(r.data.anchorHourUtc, 16);
  assert.equal(r.data.dump.minBytes, 1_048_576);
  assert.equal(r.data.timezone, "UTC");
  assert.deepEqual(r.data.dump.flags, ["-Fc", "--no-owner", "--no-privileges"]);
  assert.equal(r.data.integrity.checksum, true);
});

// ── Retention durations ──────────────────────────────────────────────────────

test("retention: defaults to 2 days / 3 weeks / 13 weeks / 2 years as { days, label }", () => {
  const d = backupSchema.safeParse(backupBase).data!;
  assert.deepEqual(d.retention.grandson, { days: 2, label: "2 days" });
  assert.deepEqual(d.retention.son, { days: 21, label: "3 weeks" });
  assert.deepEqual(d.retention.father, { days: 91, label: "13 weeks" });
  assert.deepEqual(d.retention.grandfather, { days: 730, label: "2 years" });
});

test("strict: unknown / typo'd / misplaced keys are rejected, not silently dropped", () => {
  assert.ok(!backupSchema.safeParse({ ...backupBase, bogusTopLevel: 1 }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, retention: { weekley: "1 week" } }).success); // tier typo
  // Slack creds belong in env, not under the YAML slack: group — must fail, not silently disable Slack.
  assert.ok(!backupSchema.safeParse({ ...backupBase, slack: { token: "xoxb-1", channel: "C1" } }).success);
});

test("retention: overrides parse; a malformed duration is rejected", () => {
  const ok = backupSchema.safeParse({ ...backupBase, retention: { grandfather: "1 year" } });
  assert.ok(ok.success);
  assert.deepEqual(ok.data.retention.grandfather, { days: 365, label: "1 year" });
  assert.ok(!backupSchema.safeParse({ ...backupBase, retention: { father: "soon" } }).success);
});

// ── PG URL scheme refine ─────────────────────────────────────────────────────

test("PG URL: postgres:// and postgresql:// accepted; other schemes rejected", () => {
  assert.ok(backupSchema.safeParse({ ...backupBase, credentials: { ...backupBase.credentials, databaseUrl: "postgresql://h/db" } }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, credentials: { ...backupBase.credentials, databaseUrl: "http://h/db" } }).success);
});

// ── R2 bucket light shape ────────────────────────────────────────────────────

test("R2 bucket: light shape rejects whitespace/typos but allows . _ -", () => {
  assert.ok(backupSchema.safeParse({ ...backupBase, credentials: { ...backupBase.credentials, r2: { ...r2, bucket: "my.bucket_1-2" } } }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, credentials: { ...backupBase.credentials, r2: { ...r2, bucket: "bad bucket" } } }).success);
});

// ── enums / ranges ───────────────────────────────────────────────────────────

test("encryption: enum is strict", () => {
  assert.ok(!backupSchema.safeParse({ ...backupBase, encryption: "aex" }).success);
});

test("anchor-hour-utc: integer in 0..23 (accepts a YAML number)", () => {
  assert.equal(backupSchema.safeParse({ ...backupBase, anchorHourUtc: 0 }).data?.anchorHourUtc, 0);
  assert.ok(!backupSchema.safeParse({ ...backupBase, anchorHourUtc: 24 }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, anchorHourUtc: 1.5 }).success);
});

test("drill: min-row-ratio in 0..1; max-row-ratio default 2 (>=1); max-row-drop in 0..1 default 0", () => {
  assert.equal(drillSchema.safeParse(drillBase).data?.drill.minRowRatio, 0.95);
  assert.equal(drillSchema.safeParse(drillBase).data?.drill.maxRowRatio, 2);
  assert.equal(drillSchema.safeParse(drillBase).data?.drill.maxRowDrop, 0);
  assert.ok(!drillSchema.safeParse({ ...drillBase, drill: { ...drillBase.drill, minRowRatio: 1.5 } }).success);
  assert.ok(!drillSchema.safeParse({ ...drillBase, drill: { ...drillBase.drill, maxRowRatio: 0.5 } }).success);
});

test("staleness: max-age-hours positive; slot/grace defaults; min-bytes default + coercion", () => {
  const s = backupSchema.safeParse(backupBase).data?.staleness;
  // Unset → derived from the cadence, not a fixed number: 1.5 slots at the 480/25 default.
  assert.equal(s?.maxAgeHours, 12);
  // One number, not two: the schema default IS the display constant (see DEFAULT_SLOT_MINUTES).
  assert.equal(s?.slotMinutes, DEFAULT_SLOT_MINUTES);
  assert.equal(s?.slotMinutes, 480);
  assert.equal(s?.graceMinutes, 25);
  assert.ok(!backupSchema.safeParse({ ...backupBase, staleness: { maxAgeHours: 0 } }).success);
  assert.equal(backupSchema.safeParse({ ...backupBase, dump: { minBytes: 2048 } }).data?.dump.minBytes, 2048);
});

test("staleness: max-age-hours is derived per cadence, and refused when it sits inside a slot", () => {
  const parse = (staleness: Record<string, number>) =>
    backupSchema.safeParse({ ...backupBase, staleness });

  // Derived: 1.5 slots, floored at one slot + grace + 1h.
  assert.equal(parse({ slotMinutes: 120, graceMinutes: 25 }).data?.staleness.maxAgeHours, 4);
  assert.equal(parse({ slotMinutes: 60, graceMinutes: 25 }).data?.staleness.maxAgeHours, 3);
  assert.equal(parse({ slotMinutes: 720, graceMinutes: 25 }).data?.staleness.maxAgeHours, 18);

  // An explicit value inside the slot window pages on every healthy tick — refuse it.
  const bad = parse({ slotMinutes: 480, graceMinutes: 25, maxAgeHours: 5 });
  assert.ok(!bad.success);
  assert.match(bad.error!.issues.map((i) => i.message).join(" "), /must exceed staleness.slot-minutes/);

  // Just outside the window is fine.
  assert.ok(parse({ slotMinutes: 480, graceMinutes: 25, maxAgeHours: 9 }).success);
});

test("staleness: slot-minutes must divide a whole day (else slot buckets mis-file runs)", () => {
  const parse = (slotMinutes: number) =>
    backupSchema.safeParse({ ...backupBase, staleness: { slotMinutes, graceMinutes: 5 } });
  for (const ok of [60, 120, 240, 480, 720, 1440]) {
    assert.ok(parse(ok).success, `${ok} divides 1440`);
  }
  for (const bad of [100, 7, 500, 1000]) {
    const r = parse(bad);
    assert.ok(!r.success, `${bad} does not divide 1440`);
    assert.match(r.error!.issues.map((i) => i.message).join(" "), /divide 1440/);
  }
});

test("staleness: grace-minutes must be < slot-minutes (else the slot can never go overdue)", () => {
  // Pin the slot explicitly rather than leaning on the schema default — this rule is about the
  // RELATIONSHIP between the two, and reading one of them from ambient config hides that.
  const grace = (graceMinutes: number, slotMinutes = 120) =>
    backupSchema.safeParse({ ...backupBase, staleness: { graceMinutes, slotMinutes } }).success;
  assert.ok(grace(119)); // < slot
  assert.ok(!grace(120)); // == slot
  assert.ok(!grace(200)); // > slot
  assert.ok(grace(200, 480)); // the same grace is fine against a wider slot
  assert.ok(!backupSchema.safeParse({ ...backupBase, staleness: { slotMinutes: 20, graceMinutes: 25 } }).success); // grace ≥ short slot
  assert.ok(backupSchema.safeParse({ ...backupBase, staleness: { slotMinutes: 60, graceMinutes: 25 } }).success); // 25 < 60
});

// ── table-list split ─────────────────────────────────────────────────────────

test("drill: present-tables / nonempty-tables default [] and accept YAML lists", () => {
  assert.deepEqual(drillSchema.safeParse(drillBase).data?.drill.presentTables, []);
  const r = drillSchema.safeParse({ ...drillBase, drill: { ...drillBase.drill, presentTables: ["users", "orders"], nonemptyTables: ["events"] } });
  assert.deepEqual(r.data?.drill.presentTables, ["users", "orders"]);
  assert.deepEqual(r.data?.drill.nonemptyTables, ["events"]);
});

// ── verify-durable ───────────────────────────────────────────────────────────

test("verify-durable: shares the drill grammar + adds fresh/aged/retest/max with defaults", () => {
  const r = verifyDurableSchema.safeParse(drillBase);
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.equal(r.data.verifyDurable.fresh, true);
  assert.equal(r.data.verifyDurable.aged, true);
  assert.equal(r.data.verifyDurable.retestDays, 14);
  assert.equal(r.data.verifyDurable.maxRestores, 2);
  assert.ok(!verifyDurableSchema.safeParse({ ...drillBase, verifyDurable: { retestDays: 0 } }).success);
});

// ── integrity ────────────────────────────────────────────────────────────────

test("backup: integrity defaults (checksum/check-structure on, verify off); verify+age needs age.identity", () => {
  const d = backupSchema.safeParse(backupBase).data;
  assert.equal(d?.integrity.checksum, true);
  assert.equal(d?.integrity.checkStructure, true);
  assert.equal(d?.integrity.verifyAfterUpload, false);
  const ageCreds = { ...backupBase.credentials, age: { recipient: "age1x" } };
  const age = { ...backupBase, encryption: "age", credentials: ageCreds };
  assert.ok(!backupSchema.safeParse({ ...age, integrity: { verifyAfterUpload: true } }).success);
  assert.ok(backupSchema.safeParse({ ...age, integrity: { verifyAfterUpload: true }, credentials: { ...ageCreds, age: { recipient: "age1x", identity: "/run/key" } } }).success);
});

// ── booleans: YAML boolean AND env-style string ──────────────────────────────

test("booleans: accept a real YAML boolean and an env-style string; garbage rejected", () => {
  assert.equal(backupSchema.safeParse({ ...backupBase, staleness: { selfHeal: false } }).data?.staleness.selfHeal, false);
  assert.equal(backupSchema.safeParse({ ...backupBase, staleness: { dryRun: "yes" } }).data?.staleness.dryRun, true);
  assert.equal(backupSchema.safeParse(backupBase).data?.staleness.selfHeal, true); // default
  assert.ok(!backupSchema.safeParse({ ...backupBase, staleness: { dryRun: "maybe" } }).success);
});

// ── IANA tz probe ────────────────────────────────────────────────────────────

test("timezone: a real IANA zone passes, garbage fails", () => {
  assert.equal(backupSchema.safeParse({ ...backupBase, timezone: "Australia/Perth" }).data?.timezone, "Australia/Perth");
  assert.ok(!backupSchema.safeParse({ ...backupBase, timezone: "Mars/Phobos" }).success);
});

// ── conditional credential refinements ───────────────────────────────────────

test("backup: encryption=age requires age.recipient (AGE_RECIPIENT)", () => {
  assert.ok(!backupSchema.safeParse({ ...backupBase, encryption: "age" }).success);
  assert.ok(backupSchema.safeParse({ ...backupBase, encryption: "age", credentials: { ...backupBase.credentials, age: { recipient: "age1abc" } } }).success);
});

test("drill: encryption=age requires age.identity (AGE_IDENTITY)", () => {
  assert.ok(!drillSchema.safeParse({ ...drillBase, encryption: "age" }).success);
  assert.ok(drillSchema.safeParse({ ...drillBase, encryption: "age", credentials: { ...drillBase.credentials, age: { identity: "/run/key.txt" } } }).success);
});

test("slack token (SLACK_BOT_TOKEN) set requires SLACK_CHANNEL (credentials.slackChannel)", () => {
  assert.ok(!backupSchema.safeParse({ ...backupBase, credentials: { ...backupBase.credentials, slackToken: "xoxb-1" } }).success);
  assert.ok(backupSchema.safeParse({ ...backupBase, credentials: { ...backupBase.credentials, slackToken: "xoxb-1", slackChannel: "C123" } }).success);
});

test("dashboard: --upload requires DASHBOARD_R2_BUCKET; reading R2 requires R2_BUCKET + name", () => {
  assert.ok(!dashboardSchema({ fromR2: true }).safeParse({}).success);
  assert.ok(dashboardSchema({ fromR2: true }).safeParse({ name: "e", credentials: { r2: { bucket: "b" } } }).success);
  assert.ok(!dashboardSchema({ upload: true }).safeParse({}).success);
  assert.ok(dashboardSchema({ upload: true }).safeParse({ credentials: { dashboardR2: { bucket: "d" } } }).success);
  assert.ok(dashboardSchema().safeParse({}).success); // no flags → no required buckets (e.g. --sample)
});

test("dashboard: path-prefix defaults to '' and accepts a value (shared-bucket key prefix)", () => {
  assert.equal(dashboardSchema().safeParse({}).data?.dashboard.pathPrefix, "");
  assert.equal(dashboardSchema().safeParse({ dashboard: { pathPrefix: "backups" } }).data?.dashboard.pathPrefix, "backups");
});

test("joinObjectKey: slash-clean — empty prefix, set prefix, and stray slashes never yield '//'", () => {
  assert.equal(joinObjectKey("", "boost", "index.html"), "boost/index.html");
  assert.equal(joinObjectKey("backups", "boost", "index.html"), "backups/boost/index.html");
  assert.equal(joinObjectKey("/backups/", "boost", "index.html"), "backups/boost/index.html");
  assert.equal(joinObjectKey("backups/sub", "boost", "index.html"), "backups/sub/boost/index.html");
  for (const k of [joinObjectKey("", "boost", "index.html"), joinObjectKey("/backups/", "boost", "index.html")]) {
    assert.ok(!k.includes("//") && !k.startsWith("/") && !k.endsWith("/"), `clean key: ${k}`);
  }
});

// ── Error reporting: secret-safe; kebab YAML keys + ENV names for credentials ──

test("reportConfigError: lists kebab field + ENV credential names, never values", () => {
  const r = backupSchema.safeParse({
    ...backupBase,
    anchorHourUtc: 99,
    encryption: "rot13",
    credentials: { databaseUrl: "http://nope", r2: { ...r2, bucket: "bad bucket" } },
  });
  assert.ok(!r.success);
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => (chunks.push(s), true);
  try {
    reportConfigError(r.error!);
  } finally {
    process.stderr.write = orig;
  }
  const out = chunks.join("");
  assert.ok(out.includes("anchor-hour-utc"), "kebab YAML key");
  assert.ok(out.includes("R2_BUCKET"), "credential ENV name");
  assert.ok(out.includes("PG_BACKUP_DATABASE_URL"), "credential ENV name");
  assert.ok(!out.includes("rot13") && !out.includes("bad bucket") && !out.includes("http://nope"), "no values leaked");
});

// ── CB-303: the recipient pin, and verify-before-encrypt's own requirements ──
// An age header carries an ephemeral share, not the recipient's public key, so nothing downstream
// can tell what an object was encrypted TO. If AGE_RECIPIENT drifts from the key we hold, every
// object written afterwards is unopenable and nothing says so until someone tries to decrypt one.
// The pin is the only keyless guard, so it has to fail the config rather than warn.

const aged = (over: Record<string, unknown>) =>
  backupSchema.safeParse({
    ...backupBase,
    encryption: "age",
    credentials: { ...backupBase.credentials, age: { recipient: "age1real" } },
    ...over,
  });

test("expect-recipient: a MATCHING pin passes", () => {
  assert.ok(aged({ expectRecipient: "age1real" }).success);
});

test("expect-recipient: a MISMATCHED pin fails the config, before anything is dumped", () => {
  const r = aged({ expectRecipient: "age1rotated-and-nobody-told-us" });
  assert.ok(!r.success);
  assert.match(r.error!.issues.map((i) => i.message).join(" "), /does not match the pinned expect-recipient/);
});

test("expect-recipient: absent → no check (an unpinned profile keeps working)", () => {
  assert.ok(aged({}).success);
});

test("verify-before-encrypt needs a drill target and a sentinel table — but NOT an identity", () => {
  // The whole point: this verification runs on the plaintext, so requiring AGE_IDENTITY here
  // would reintroduce exactly the dependency CB-303 removes.
  const withoutDrill = backupSchema.safeParse({
    ...backupBase,
    encryption: "age",
    credentials: { ...backupBase.credentials, age: { recipient: "age1real" } },
    integrity: { verifyBeforeEncrypt: true },
  });
  assert.ok(!withoutDrill.success);
  const msgs = withoutDrill.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
  assert.match(msgs, /drillDatabaseUrl/);
  assert.match(msgs, /rowCountTable/);
  assert.doesNotMatch(msgs, /identity/, "verify-before-encrypt must never require the decrypt key");

  const withDrill = backupSchema.safeParse({
    ...backupBase,
    encryption: "age",
    drill: { rowCountTable: "people" },
    credentials: {
      ...backupBase.credentials,
      age: { recipient: "age1real" },
      drillDatabaseUrl: "postgresql://u:p@h:5432/drill",
    },
    integrity: { verifyBeforeEncrypt: true },
  });
  assert.ok(withDrill.success, JSON.stringify(withDrill.error?.issues));
});

test("integrity defaults: verify-before-encrypt is OFF until a profile opts in", () => {
  const d = backupSchema.safeParse(backupBase).data;
  assert.equal(d?.integrity.verifyBeforeEncrypt, false);
});

// ── CB-303: keyless durable-verify ──────────────────────────────────────────
// Hash checks only — no decrypt key, no database. Declared rather than inferred from a missing
// AGE_IDENTITY, because "we chose not to decrypt" and "we lost the key" must not look the same.

const keylessBase = { name: "example", backupPrefix: "pg/example", credentials: { r2 } };

test("verify-durable keyless: needs NO drill target and NO live database", () => {
  const r = verifyDurableSchema.safeParse({
    ...keylessBase,
    verifyDurable: { keyless: true, aged: false },
  });
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.equal(r.data.verifyDurable.keyless, true);
});

test("verify-durable keyless: REFUSES an identity in its environment", () => {
  // Not merely unused — a live secret sitting in a job that has declared it cannot decrypt. The
  // only way anyone notices is a check that says so.
  const r = verifyDurableSchema.safeParse({
    ...keylessBase,
    encryption: "age",
    verifyDurable: { keyless: true, aged: false },
    credentials: { r2, age: { identity: "AGE-SECRET-KEY-1LEFTBEHIND" } },
  });
  assert.ok(!r.success);
  assert.match(r.error!.issues.map((i) => i.message).join(" "), /must NOT be set when verify-durable\.keyless/);
});

test("verify-durable keyless: refuses the AGED leg, which is a restore", () => {
  const r = verifyDurableSchema.safeParse({ ...keylessBase, verifyDurable: { keyless: true, aged: true } });
  assert.ok(!r.success);
  assert.match(r.error!.issues.map((i) => i.message).join(" "), /aged leg is a restore/);
});

test("verify-durable NOT keyless: a missing identity under age still FAILS the run", () => {
  // The regression this guards: silently downgrading to a hash-only check that still reports
  // success is how a verification comes to cover far less than its green tick claims.
  const r = verifyDurableSchema.safeParse({ ...drillBase, encryption: "age" });
  assert.ok(!r.success);
  assert.match(r.error!.issues.map((i) => i.message).join(" "), /required when encryption=age/);
});

test("drill (the manual one) still requires the identity under age — keyless does not apply to it", () => {
  const r = drillSchema.safeParse({ ...drillBase, encryption: "age", verifyDurable: { keyless: true } });
  assert.ok(!r.success);
  assert.match(r.error!.issues.map((i) => i.message).join(" "), /required when encryption=age/);
});

test("verify-durable keyless defaults OFF — existing profiles keep restoring", () => {
  assert.equal(verifyDurableSchema.safeParse(drillBase).data?.verifyDurable.keyless, false);
});

test("verify-durable: the re-hash rotation and drill-staleness defaults", () => {
  const d = verifyDurableSchema.safeParse(drillBase).data?.verifyDurable;
  assert.equal(d?.rehashPerRun, 1, "on by default — every deployment has the hash-once weakness");
  assert.equal(d?.rehashMaxAgeDays, 90, "the rotation's own dead-man's switch, on by default");
  assert.equal(d?.drillMaxAgeDays, 0, "off by default — only keyless deployments depend on a manual drill");
});
