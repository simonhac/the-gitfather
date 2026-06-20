// ─────────────────────────────────────────────────────────────────────────────
// Central, zod-validated, typed config for each task. Replaces the presence-only
// requireEnv/numEnv/wordsEnv reads: every task now fails fast at startup with ONE
// aggregated, human-readable report if any required variable is missing or malformed.
//
// Grammar philosophy (the plan's "lenient where it can't prove validity"):
//   • STRICT semantic checks where a typo is genuinely catchable — enums (ENCRYPTION),
//     numeric ranges (ANCHOR_HOUR_UTC 0..23, MIN_RATIO 0..1, STALE_HOURS > 0), a real
//     IANA-tz probe (DISPLAY_TZ), env-boolean coercion (SELF_HEAL/DRY_RUN/…), and the
//     {2hourly,daily,weekly,monthly} tier vocabulary (FORCE_TIERS).
//   • LENIENT presence + light shape for credentials / identifiers / URLs — a 32-hex
//     R2 account id, an `age1…` vs ssh recipient, an sslmode-less PG URL are all valid
//     edge configs. Real credential/endpoint validity is proven by doctor's live probes
//     (lib/preflight.ts), never by a regex here.
//
// loadConfig() prints var NAMES only (z.prettifyError) — it never echoes a value, so a
// secret can't leak into a log — and exits 1. Config errors are pre-flight: no Slack.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

// ── Reusable grammars ────────────────────────────────────────────────────────

const TIERS = ["2hourly", "daily", "weekly", "monthly"] as const;
const ENCRYPTIONS = ["none", "age", "aes-gcm"] as const;

/** Non-empty string — the lenient "presence" check for credentials/identifiers. */
const nonEmpty = (msg = "must be set") => z.string().min(1, msg);

/** Treat "" (a blank profile assignment) as unset, then make the schema optional. */
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

/** Required string with a fallback; unset OR blank → `def`. */
const strDefault = (def: string) =>
  z.preprocess((v) => (v === undefined || v === "" ? def : v), z.string());

const isBlank = (v: unknown): boolean => v === undefined || (typeof v === "string" && v.trim() === "");

/** Coerced integer in [min,max] with a default; unset/blank → def, garbage/out-of-range → error. */
const intIn = (def: number, min: number, max: number) =>
  z.preprocess((v) => (isBlank(v) ? def : v), z.coerce.number().int().min(min).max(max));

/** Coerced number in [min,max] with a default. */
const numIn = (def: number, min: number, max: number) =>
  z.preprocess((v) => (isBlank(v) ? def : v), z.coerce.number().min(min).max(max));

/** Optional coerced integer (no default) — unset/blank → undefined. */
const optInt = (min: number, max: number) =>
  z.preprocess((v) => (isBlank(v) ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

/** Env-boolean: 1/0 · true/false · yes/no · on/off (lenient), but garbage → error. Unset/blank → def. */
const boolIn = (def: boolean) =>
  z.preprocess((v) => (v === undefined || v === "" ? (def ? "true" : "false") : v), z.stringbool());

/** Postgres connection URL — parses + scheme ∈ {postgres,postgresql}. Lenient on host/port/sslmode. */
function isPgUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "postgres:" || u.protocol === "postgresql:";
  } catch {
    return false;
  }
}
const pgUrl = nonEmpty().refine(isPgUrl, "must be a postgres:// or postgresql:// URL");

/** R2 bucket / dashboard bucket — light shape catches whitespace/typos, not validity. */
const bucket = nonEmpty().regex(/^[A-Za-z0-9._-]+$/, "may only contain letters, digits, . _ -");

/** A (optionally schema-qualified) Postgres table name. */
const tableName = z.string().regex(/^[\w.]+$/, "must be a table name (letters, digits, _ and .)");

/** IANA timezone, probed via Intl (default UTC). */
function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
const displayTz = z.string().default("UTC").refine(isValidTz, "must be a valid IANA timezone (e.g. UTC, Australia/Perth)");

/** Whitespace-split → list of table names (DRILL_EXTRA_TABLES); unset → []. */
const tableList = z
  .preprocess((v) => (typeof v === "string" ? v.split(/\s+/).filter(Boolean) : v), z.array(tableName))
  .default([]);

/** Whitespace-split → list of tiers (FORCE_TIERS); unset → []. Unknown tier name → error. */
const tierList = z
  .preprocess((v) => (typeof v === "string" ? v.split(/\s+/).filter(Boolean) : v), z.array(z.enum(TIERS)))
  .default([]);

/** PG_DUMP_FLAGS → argv array; unset/blank → the standard custom-format flags. */
const dumpFlags = z
  .preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? v : "-Fc --no-owner --no-privileges"),
    z.string(),
  )
  .transform((s) => s.split(/\s+/).filter(Boolean));

/** SLACK_BOT_TOKEN set ⇒ SLACK_CHANNEL must be set too (else the row silently never posts). */
function requireSlackChannel(
  v: { SLACK_BOT_TOKEN?: string; SLACK_CHANNEL?: string },
  ctx: z.core.$RefinementCtx,
): void {
  if (v.SLACK_BOT_TOKEN && !v.SLACK_CHANNEL) {
    ctx.addIssue({ code: "custom", path: ["SLACK_CHANNEL"], message: "required when SLACK_BOT_TOKEN is set" });
  }
}

// ── Per-task schemas ─────────────────────────────────────────────────────────

export const backupSchema = z
  .object({
    PROFILE: nonEmpty("set PROFILE to a profiles/*.env file"),
    BACKUP_PREFIX: nonEmpty("profile must set BACKUP_PREFIX"),
    FILE_BASENAME: nonEmpty("profile must set FILE_BASENAME"),
    PG_BACKUP_DATABASE_URL: pgUrl,
    R2_ACCOUNT_ID: nonEmpty(),
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: nonEmpty(),
    R2_SECRET_ACCESS_KEY: nonEmpty(),
    ENCRYPTION: z.enum(ENCRYPTIONS).default("none"),
    AGE_RECIPIENT: opt(nonEmpty()),
    MIN_BYTES: intIn(1_048_576, 0, Number.MAX_SAFE_INTEGER),
    ANCHOR_HOUR_UTC: intIn(16, 0, 23),
    PG_DUMP_FLAGS: dumpFlags,
    PG_CLIENT_MAJOR: optInt(1, 99),
    FORCE_TIERS: tierList,
    HEARTBEAT_URL: opt(z.url()),
    SLACK_BOT_TOKEN: opt(nonEmpty()),
    SLACK_CHANNEL: opt(nonEmpty()),
    DASHBOARD_URL: opt(z.url()),
    ALERT_WEBHOOK_URL: opt(z.url()),
    DISPLAY_TZ: displayTz,
  })
  .superRefine(requireSlackChannel)
  .superRefine((v, ctx) => {
    if (v.ENCRYPTION === "age" && !v.AGE_RECIPIENT) {
      ctx.addIssue({ code: "custom", path: ["AGE_RECIPIENT"], message: "required when ENCRYPTION=age" });
    }
  });

export const drillSchema = z
  .object({
    PROFILE: nonEmpty("set PROFILE to a profiles/*.env file"),
    BACKUP_PREFIX: nonEmpty("profile must set BACKUP_PREFIX"),
    FILE_BASENAME: strDefault("pg"),
    DRILL_SENTINEL_TABLE: nonEmpty("profile must set DRILL_SENTINEL_TABLE").regex(
      /^[\w.]+$/,
      "must be a table name (letters, digits, _ and .)",
    ),
    DRILL_EXTRA_TABLES: tableList,
    R2_ACCOUNT_ID: nonEmpty(),
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: nonEmpty(),
    R2_SECRET_ACCESS_KEY: nonEmpty(),
    DRILL_DATABASE_URL: pgUrl,
    PG_LIVE_DATABASE_URL: pgUrl,
    MIN_RATIO: numIn(0.95, 0, 1),
    ENCRYPTION: z.enum(ENCRYPTIONS).default("none"),
    AGE_IDENTITY: opt(nonEmpty()),
    PG_CLIENT_MAJOR: optInt(1, 99),
    SLACK_BOT_TOKEN: opt(nonEmpty()),
    SLACK_CHANNEL: opt(nonEmpty()),
    ALERT_WEBHOOK_URL: opt(z.url()),
    DISPLAY_TZ: displayTz,
  })
  .superRefine(requireSlackChannel)
  .superRefine((v, ctx) => {
    if (v.ENCRYPTION === "age" && !v.AGE_IDENTITY) {
      ctx.addIssue({
        code: "custom",
        path: ["AGE_IDENTITY"],
        message: "required when ENCRYPTION=age (needed to decrypt .age objects)",
      });
    }
  });

export const stalenessSchema = z
  .object({
    PROFILE: nonEmpty("set PROFILE to a profiles/*.env file"),
    BACKUP_PREFIX: nonEmpty("profile must set BACKUP_PREFIX"),
    FILE_BASENAME: nonEmpty("profile must set FILE_BASENAME"),
    R2_ACCOUNT_ID: nonEmpty(),
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: nonEmpty(),
    R2_SECRET_ACCESS_KEY: nonEmpty(),
    STALE_HOURS: intIn(3, 1, Number.MAX_SAFE_INTEGER),
    BACKUP_WORKFLOW: strDefault("pg-backup.yml"),
    SELF_HEAL: boolIn(true),
    DRY_RUN: boolIn(false),
    SLACK_BOT_TOKEN: opt(nonEmpty()),
    SLACK_CHANNEL: opt(nonEmpty()),
    ALERT_WEBHOOK_URL: opt(z.url()),
    DISPLAY_TZ: displayTz,
  })
  .superRefine(requireSlackChannel);

/**
 * Dashboard config. The DASHBOARD_R2_* / R2_BUCKET requirements depend on RUNTIME flags
 * (reading logs from R2 vs --sample/--logdir; --upload), so the schema is parameterised:
 * build-dashboard.ts passes the flags it parsed; doctor validates with fromR2:true.
 */
export function dashboardSchema(opts: { fromR2?: boolean; upload?: boolean } = {}) {
  return z
    .object({
      DASHBOARD_LABEL: opt(nonEmpty()),
      FILE_BASENAME: opt(nonEmpty()),
      DASHBOARD_HIDE_RUN_LINKS: boolIn(false),
      R2_BUCKET: opt(bucket),
      DASHBOARD_R2_BUCKET: opt(bucket),
      DISPLAY_TZ: displayTz,
    })
    .superRefine((v, ctx) => {
      if (opts.fromR2 && !v.R2_BUCKET) {
        ctx.addIssue({
          code: "custom",
          path: ["R2_BUCKET"],
          message: "required to read logs from R2 (or pass --sample / --logdir)",
        });
      }
      if (opts.fromR2 && !v.FILE_BASENAME) {
        ctx.addIssue({ code: "custom", path: ["FILE_BASENAME"], message: "required to read logs from R2" });
      }
      if (opts.upload && !v.DASHBOARD_R2_BUCKET) {
        ctx.addIssue({ code: "custom", path: ["DASHBOARD_R2_BUCKET"], message: "required with --upload" });
      }
    });
}

// ── Typed outputs ────────────────────────────────────────────────────────────

export type BackupConfig = z.infer<typeof backupSchema>;
export type DrillConfig = z.infer<typeof drillSchema>;
export type StalenessConfig = z.infer<typeof stalenessSchema>;
export type DashboardConfig = z.infer<ReturnType<typeof dashboardSchema>>;

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Print a config validation failure to stderr — every issue at once, names only (never a value, so it's
 * secret-safe). Factored out of loadConfig so a task can validate via safeParse, record a failure
 * (e.g. backup-pg-to-r2's ❌ Slack tick), and then emit the same report before exiting.
 */
export function reportConfigError(err: z.ZodError): void {
  process.stderr.write("✗ config validation failed:\n\n");
  process.stderr.write(`${z.prettifyError(err)}\n\n`);
  process.stderr.write("Fix the variable(s) above in your profile or environment, then re-run.\n");
}

/**
 * Validate process.env against `schema`. On failure, print every issue at once (names
 * only — never a value) and exit 1; on success, return the typed config. Shared by the
 * tasks AND doctor, so the two can never drift.
 */
export function loadConfig<T extends z.ZodType>(schema: T): z.infer<T> {
  const res = schema.safeParse(process.env);
  if (!res.success) {
    reportConfigError(res.error);
    process.exit(1);
  }
  return res.data;
}

export const loadBackupConfig = (): BackupConfig => loadConfig(backupSchema);
export const loadDrillConfig = (): DrillConfig => loadConfig(drillSchema);
export const loadStalenessConfig = (): StalenessConfig => loadConfig(stalenessSchema);
export const loadDashboardConfig = (opts?: { fromR2?: boolean; upload?: boolean }): DashboardConfig =>
  loadConfig(dashboardSchema(opts));
