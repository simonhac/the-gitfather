import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backupSchema,
  drillSchema,
  verifyDurableSchema,
  stalenessSchema,
  dashboardSchema,
  reportConfigError,
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
const stalenessBase = { name: "example", backupPrefix: "pg/example", credentials: { r2 } };

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

test("staleness: max-age-hours positive; min-bytes default + coercion", () => {
  assert.equal(stalenessSchema.safeParse(stalenessBase).data?.staleness.maxAgeHours, 3);
  assert.ok(!stalenessSchema.safeParse({ ...stalenessBase, staleness: { maxAgeHours: 0 } }).success);
  assert.equal(stalenessSchema.safeParse({ ...stalenessBase, dump: { minBytes: 2048 } }).data?.dump.minBytes, 2048);
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
  assert.equal(stalenessSchema.safeParse({ ...stalenessBase, staleness: { selfHeal: false } }).data?.staleness.selfHeal, false);
  assert.equal(stalenessSchema.safeParse({ ...stalenessBase, staleness: { dryRun: "yes" } }).data?.staleness.dryRun, true);
  assert.equal(stalenessSchema.safeParse(stalenessBase).data?.staleness.selfHeal, true); // default
  assert.ok(!stalenessSchema.safeParse({ ...stalenessBase, staleness: { dryRun: "maybe" } }).success);
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
