import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { backupSchema, drillSchema, stalenessSchema, dashboardSchema } from "../lib/config.js";

// Minimal valid inputs per task — tests then mutate one field at a time.
const backupBase = {
  PROFILE: "profiles/example.env",
  BACKUP_PREFIX: "pg/example",
  FILE_BASENAME: "example",
  PG_BACKUP_DATABASE_URL: "postgres://u:p@h:5432/db?sslmode=require",
  R2_ACCOUNT_ID: "acct",
  R2_BUCKET: "my-bucket",
  R2_ACCESS_KEY_ID: "k",
  R2_SECRET_ACCESS_KEY: "s",
};
const drillBase = {
  PROFILE: "profiles/example.env",
  BACKUP_PREFIX: "pg/example",
  DRILL_SENTINEL_TABLE: "public.things",
  R2_ACCOUNT_ID: "acct",
  R2_BUCKET: "my-bucket",
  R2_ACCESS_KEY_ID: "k",
  R2_SECRET_ACCESS_KEY: "s",
  DRILL_DATABASE_URL: "postgresql://u:p@h:5432/drill",
  PG_LIVE_DATABASE_URL: "postgres://u:p@h:5432/live",
};
const stalenessBase = {
  PROFILE: "profiles/example.env",
  BACKUP_PREFIX: "pg/example",
  FILE_BASENAME: "example",
  R2_ACCOUNT_ID: "acct",
  R2_BUCKET: "my-bucket",
  R2_ACCESS_KEY_ID: "k",
  R2_SECRET_ACCESS_KEY: "s",
};

// ── Defaults & coercion ──────────────────────────────────────────────────────

test("backup: defaults applied for an otherwise-minimal config", () => {
  const r = backupSchema.safeParse(backupBase);
  assert.ok(r.success);
  assert.equal(r.data.ENCRYPTION, "none");
  assert.equal(r.data.ANCHOR_HOUR_UTC, 16);
  assert.equal(r.data.MIN_BYTES, 1_048_576);
  assert.equal(r.data.DISPLAY_TZ, "UTC");
  assert.deepEqual(r.data.PG_DUMP_FLAGS, ["-Fc", "--no-owner", "--no-privileges"]);
  assert.deepEqual(r.data.FORCE_TIERS, []);
});

// ── PG URL scheme refine ─────────────────────────────────────────────────────

test("PG URL: postgres:// and postgresql:// accepted; other schemes rejected", () => {
  assert.ok(backupSchema.safeParse({ ...backupBase, PG_BACKUP_DATABASE_URL: "postgresql://h/db" }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, PG_BACKUP_DATABASE_URL: "http://h/db" }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, PG_BACKUP_DATABASE_URL: "not a url" }).success);
});

// ── R2 bucket light shape ────────────────────────────────────────────────────

test("R2 bucket: light shape rejects whitespace/typos but allows . _ -", () => {
  assert.ok(backupSchema.safeParse({ ...backupBase, R2_BUCKET: "my.bucket_1-2" }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, R2_BUCKET: "bad bucket" }).success);
});

// ── ENCRYPTION enum ──────────────────────────────────────────────────────────

test("ENCRYPTION: enum is strict", () => {
  assert.ok(backupSchema.safeParse({ ...backupBase, ENCRYPTION: "age", AGE_RECIPIENT: "age1xyz" }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, ENCRYPTION: "aex" }).success);
});

// ── Numeric range checks ─────────────────────────────────────────────────────

test("ANCHOR_HOUR_UTC: integer in 0..23", () => {
  assert.equal(backupSchema.safeParse({ ...backupBase, ANCHOR_HOUR_UTC: "0" }).data?.ANCHOR_HOUR_UTC, 0);
  assert.equal(backupSchema.safeParse({ ...backupBase, ANCHOR_HOUR_UTC: "23" }).data?.ANCHOR_HOUR_UTC, 23);
  assert.ok(!backupSchema.safeParse({ ...backupBase, ANCHOR_HOUR_UTC: "24" }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, ANCHOR_HOUR_UTC: "-1" }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, ANCHOR_HOUR_UTC: "abc" }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, ANCHOR_HOUR_UTC: "1.5" }).success);
});

test("MIN_RATIO: number in 0..1", () => {
  assert.equal(drillSchema.safeParse({ ...drillBase, MIN_RATIO: "0.9" }).data?.MIN_RATIO, 0.9);
  assert.ok(!drillSchema.safeParse({ ...drillBase, MIN_RATIO: "1.5" }).success);
  assert.ok(!drillSchema.safeParse({ ...drillBase, MIN_RATIO: "-0.1" }).success);
});

test("STALE_HOURS: positive integer", () => {
  assert.equal(stalenessSchema.safeParse({ ...stalenessBase, STALE_HOURS: "5" }).data?.STALE_HOURS, 5);
  assert.ok(!stalenessSchema.safeParse({ ...stalenessBase, STALE_HOURS: "0" }).success);
});

// ── IANA tz probe ────────────────────────────────────────────────────────────

test("DISPLAY_TZ: a real IANA zone passes, garbage fails", () => {
  assert.equal(backupSchema.safeParse({ ...backupBase, DISPLAY_TZ: "Australia/Perth" }).data?.DISPLAY_TZ, "Australia/Perth");
  assert.ok(!backupSchema.safeParse({ ...backupBase, DISPLAY_TZ: "Mars/Phobos" }).success);
});

// ── FORCE_TIERS split + enum ─────────────────────────────────────────────────

test("FORCE_TIERS: whitespace-split into the tier enum; unknown tier rejected", () => {
  const r = backupSchema.safeParse({ ...backupBase, FORCE_TIERS: "2hourly  daily weekly" });
  assert.ok(r.success);
  assert.deepEqual(r.data.FORCE_TIERS, ["2hourly", "daily", "weekly"]);
  assert.ok(!backupSchema.safeParse({ ...backupBase, FORCE_TIERS: "daily bogus" }).success);
});

// ── Env booleans ─────────────────────────────────────────────────────────────

test("SELF_HEAL/DRY_RUN: env-boolean coercion; garbage rejected", () => {
  const r = stalenessSchema.safeParse({ ...stalenessBase, SELF_HEAL: "0", DRY_RUN: "yes" });
  assert.ok(r.success);
  assert.equal(r.data.SELF_HEAL, false);
  assert.equal(r.data.DRY_RUN, true);
  assert.equal(stalenessSchema.safeParse(stalenessBase).data?.SELF_HEAL, true); // default true
  assert.ok(!stalenessSchema.safeParse({ ...stalenessBase, DRY_RUN: "maybe" }).success);
});

// ── Conditional refinements ──────────────────────────────────────────────────

test("backup: ENCRYPTION=age requires AGE_RECIPIENT", () => {
  assert.ok(!backupSchema.safeParse({ ...backupBase, ENCRYPTION: "age" }).success);
  assert.ok(backupSchema.safeParse({ ...backupBase, ENCRYPTION: "age", AGE_RECIPIENT: "age1abc" }).success);
});

test("drill: ENCRYPTION=age requires AGE_IDENTITY", () => {
  assert.ok(!drillSchema.safeParse({ ...drillBase, ENCRYPTION: "age" }).success);
  assert.ok(drillSchema.safeParse({ ...drillBase, ENCRYPTION: "age", AGE_IDENTITY: "/run/key.txt" }).success);
});

test("SLACK_BOT_TOKEN set requires SLACK_CHANNEL", () => {
  assert.ok(!backupSchema.safeParse({ ...backupBase, SLACK_BOT_TOKEN: "xoxb-1" }).success);
  assert.ok(backupSchema.safeParse({ ...backupBase, SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL: "C123" }).success);
});

test("DASHBOARD_URL: optional, but must be a URL when set", () => {
  assert.ok(backupSchema.safeParse(backupBase).success); // unset is fine
  assert.ok(backupSchema.safeParse({ ...backupBase, DASHBOARD_URL: "" }).success); // blank treated as unset
  assert.ok(backupSchema.safeParse({ ...backupBase, DASHBOARD_URL: "https://dash.example.com/" }).success);
  assert.ok(!backupSchema.safeParse({ ...backupBase, DASHBOARD_URL: "not a url" }).success);
});

test("dashboard: --upload requires DASHBOARD_R2_BUCKET; reading R2 requires R2_BUCKET", () => {
  assert.ok(!dashboardSchema({ fromR2: true }).safeParse({}).success);
  assert.ok(dashboardSchema({ fromR2: true }).safeParse({ R2_BUCKET: "b", FILE_BASENAME: "e" }).success);
  assert.ok(!dashboardSchema({ upload: true }).safeParse({}).success);
  assert.ok(dashboardSchema({ upload: true }).safeParse({ DASHBOARD_R2_BUCKET: "d" }).success);
  assert.ok(dashboardSchema().safeParse({}).success); // no flags → no required buckets (e.g. --sample)
});

// ── Aggregation: every issue at once ─────────────────────────────────────────

test("prettifyError lists every issue at once, by variable name, without values", () => {
  const r = backupSchema.safeParse({
    ...backupBase,
    PG_BACKUP_DATABASE_URL: "http://nope",
    ANCHOR_HOUR_UTC: "99",
    ENCRYPTION: "rot13",
    R2_BUCKET: "bad bucket",
  });
  assert.ok(!r.success);
  const pretty = z.prettifyError(r.error);
  for (const name of ["PG_BACKUP_DATABASE_URL", "ANCHOR_HOUR_UTC", "ENCRYPTION", "R2_BUCKET"]) {
    assert.ok(pretty.includes(name), `expected report to mention ${name}`);
  }
  // never echoes the offending values
  assert.ok(!pretty.includes("rot13"));
  assert.ok(!pretty.includes("bad bucket"));
});
