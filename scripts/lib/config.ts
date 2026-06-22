// ─────────────────────────────────────────────────────────────────────────────
// Central, zod-validated, typed config. The profile is a single nested YAML file
// (profiles/*.yaml, kebab-case keys); the loader (lib/profile.ts) parses it, maps
// kebab → camelCase, and merges credentials from the environment (GitHub secrets,
// never the file). This module validates that combined object and exposes one typed
// `Profile` per task — so config validation and doctor's preflight can never drift.
//
// Grammar philosophy ("lenient where it can't prove validity"):
//   • STRICT semantic checks where a typo is genuinely catchable — enums (encryption),
//     numeric ranges (anchor-hour-utc 0..23, min-row-ratio 0..1, …), a real IANA-tz probe
//     (timezone), env-boolean coercion, and natural-language durations (retention).
//   • LENIENT presence + light shape for credentials / identifiers / URLs — real
//     credential/endpoint validity is proven by doctor's live probes (lib/preflight.ts).
//
// reportConfigError prints field NAMES only (never a value, so a secret can't leak) — YAML
// fields as their kebab key, credentials as their ENV var name (that's where users set them).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { parseDuration, type Duration } from "./duration.js";
import { DEFAULT_RETENTION, type RetentionMap } from "./backupTypes.js";
import { buildRawProfile } from "./profile.js";

// ── Reusable grammars ────────────────────────────────────────────────────────

const ENCRYPTIONS = ["none", "age", "aes-gcm"] as const;

const nonEmpty = (msg = "must be set") => z.string().min(1, msg);

/** Treat "" (a blank assignment) as unset, then make the schema optional. */
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const strDefault = (def: string) =>
  z.preprocess((v) => (v === undefined || v === "" ? def : v), z.string());

const isBlank = (v: unknown): boolean => v === undefined || (typeof v === "string" && v.trim() === "");

const intIn = (def: number, min: number, max: number) =>
  z.preprocess((v) => (isBlank(v) ? def : v), z.coerce.number().int().min(min).max(max));

const numIn = (def: number, min: number, max: number) =>
  z.preprocess((v) => (isBlank(v) ? def : v), z.coerce.number().min(min).max(max));

const optInt = (min: number, max: number) =>
  z.preprocess((v) => (isBlank(v) ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

// Accepts a real YAML boolean OR an env-style string (1/0 · true/false · yes/no · on/off); unset/blank → def.
const boolIn = (def: boolean) =>
  z.preprocess((v) => {
    if (v === undefined || v === "") return def;
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off"].includes(s)) return false;
    }
    return v; // anything else → let z.boolean() reject it
  }, z.boolean());

function isPgUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "postgres:" || u.protocol === "postgresql:";
  } catch {
    return false;
  }
}
const pgUrl = nonEmpty().refine(isPgUrl, "must be a postgres:// or postgresql:// URL");

const bucket = nonEmpty().regex(/^[A-Za-z0-9._-]+$/, "may only contain letters, digits, . _ -");

const tableName = z.string().regex(/^[\w.]+$/, "must be a table name (letters, digits, _ and .)");

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
const timezone = z.string().default("UTC").refine(isValidTz, "must be a valid IANA timezone (e.g. UTC, Australia/Perth)");

/** YAML list (or whitespace string) → table names; unset → []. */
const tableList = z
  .preprocess(
    (v) => (typeof v === "string" ? v.split(/\s+/).filter(Boolean) : v),
    z.array(tableName),
  )
  .default([]);

/** dump.flags → argv array; unset/blank → the standard custom-format flags. */
const dumpFlags = z
  .preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? v : "-Fc --no-owner --no-privileges"),
    z.string(),
  )
  .transform((s) => s.split(/\s+/).filter(Boolean));

/** Natural-language duration ("13 weeks") → { days, label }; unset/blank → the tier default. */
const durationField = (def: Duration) =>
  z.preprocess(
    (v) => (isBlank(v) ? def.label : v),
    z.string().transform((s, ctx): Duration => {
      try {
        return parseDuration(s);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: (e as Error).message });
        return z.NEVER;
      }
    }),
  );

// ── Config groups (camelCase, from the YAML profile) ─────────────────────────

const dumpGroup = z
  .object({
    flags: dumpFlags,
    clientMajor: optInt(1, 99),
    minBytes: intIn(1_048_576, 0, Number.MAX_SAFE_INTEGER),
  })
  .strict().prefault({} as never);

const integrityGroup = z
  .object({
    checksum: boolIn(true), // record a SHA-256 of the uploaded object (durable hash baseline)
    checkStructure: boolIn(true), // pg_restore -l TOC check before declaring success (none-mode)
    verifyAfterUpload: boolIn(false), // re-download + (decrypt) + pg_restore -l (only age-mode structural check)
  })
  .strict().prefault({} as never);

const retentionGroup = z
  .object({
    grandson: durationField(DEFAULT_RETENTION["2hourly"]),
    son: durationField(DEFAULT_RETENTION.daily),
    father: durationField(DEFAULT_RETENTION.weekly),
    grandfather: durationField(DEFAULT_RETENTION.monthly),
  })
  .strict().prefault({} as never);

const drillGroup = z
  .object({
    // required by the drill/verify-durable tasks (see requireDrillCreds), optional at the profile level so
    // a backup-only profile without a drill: block still validates.
    rowCountTable: opt(nonEmpty().regex(/^[\w.]+$/, "must be a table name (letters, digits, _ and .)")),
    presentTables: tableList, // must EXIST in the restore (rows optional)
    nonemptyTables: tableList, // must exist AND have ≥1 row
    minRowRatio: numIn(0.95, 0, 1), // restored/live floor for the row-count table
    maxRowRatio: numIn(2, 1, 1_000_000), // restored/live ceiling — catches duplicated/double-restored rows
    maxRowDrop: numIn(0, 0, 1), // 0 = off; else fail if a table dropped > this fraction vs the prior passing drill
  })
  .strict().prefault({} as never);

const verifyDurableGroup = z
  .object({
    fresh: boolIn(true), // hash-check new durable objects + restore the freshest daily
    aged: boolIn(true), // re-restore the newest weekly/monthly ≥ retest-days old
    retestDays: intIn(14, 1, 365), // 13 to re-validate while still inside the 14-day WORM lock
    maxRestores: intIn(2, 0, 100), // cap full restores per run (hash-checks uncapped)
  })
  .strict().prefault({} as never);

const stalenessGroup = z
  .object({
    // Primary trigger is slot-based (slotMinutes/graceMinutes); maxAgeHours is a backstop that still
    // pages if the slot math is misconfigured and a truly ancient object slips through.
    maxAgeHours: intIn(3, 1, Number.MAX_SAFE_INTEGER), // backstop: page if newest 2hourly object is older than this
    slotMinutes: intIn(120, 1, 1440), // backup cadence in minutes — MUST match the caller's cron interval
    graceMinutes: intIn(25, 0, 720), // minutes past a slot boundary before the slot counts as overdue
    healWorkflow: strDefault("pg-backup.yml"), // workflow self-heal re-triggers
    selfHeal: boolIn(true),
    dryRun: boolIn(false),
  })
  .strict().prefault({} as never);

const slackGroup = z
  .object({
    // the channel id is a deployment identifier paired with the bot token, so it lives in the env
    // credentials group (SLACK_CHANNEL), like r2.bucket pairs with the R2 keys — not here.
    alertMention: strDefault("<!here>"),
  })
  .strict().prefault({} as never);

const dashboardGroup = z
  .object({
    label: opt(nonEmpty()),
    hideRunLinks: boolIn(false),
    url: opt(z.url()),
    // YAML: path-prefix. Object-key prefix under the (possibly shared) dashboard bucket, so several
    // projects can live behind one custom domain: <path-prefix>/<name>/index.html. Default "" → no
    // prefix (<name>/index.html). Leading/trailing slashes are tolerated (see joinObjectKey).
    pathPrefix: strDefault(""),
  })
  .strict().prefault({} as never);

/**
 * Join object-key segments into a clean R2 key: split each on "/", drop blanks, rejoin with "/".
 * Guarantees no "//" and no leading/trailing slash, and tolerates a path-prefix written as
 * "backups", "/backups", or "backups/". e.g. ("", "boost", "index.html") → "boost/index.html";
 * ("/backups/", "boost", "index.html") → "backups/boost/index.html".
 */
export function joinObjectKey(...segments: string[]): string {
  return segments.flatMap((s) => s.split("/")).filter(Boolean).join("/");
}

// ── Credentials (from env/secrets; all optional here — per-task refinements require them) ──

const r2Creds = z
  .object({
    accountId: opt(nonEmpty()),
    bucket: opt(bucket),
    accessKeyId: opt(nonEmpty()),
    secretAccessKey: opt(nonEmpty()),
  })
  .strict().prefault({} as never);

const credentialsGroup = z
  .object({
    databaseUrl: opt(pgUrl), // PG_BACKUP_DATABASE_URL
    drillDatabaseUrl: opt(pgUrl), // DRILL_DATABASE_URL
    liveDatabaseUrl: opt(pgUrl), // PG_LIVE_DATABASE_URL
    r2: r2Creds,
    dashboardR2: r2Creds,
    age: z.object({ recipient: opt(nonEmpty()), identity: opt(nonEmpty()) }).strict().prefault({} as never),
    slackToken: opt(nonEmpty()), // SLACK_BOT_TOKEN (secret)
    slackChannel: opt(nonEmpty()), // SLACK_CHANNEL (non-secret id, paired with the token; a GitHub Variable)
    heartbeatUrl: opt(z.url()), // HEARTBEAT_URL
    alertWebhookUrl: opt(z.url()), // ALERT_WEBHOOK_URL
  })
  .strict().prefault({} as never);

// ── Full profile schema (loose creds) — drives getProfile()'s typed singleton ────────────

export const profileSchema = z.object({
  // required by every real task (see requireNameAndPrefix), optional at the profile level so the
  // dashboard --sample path (which needs neither) still validates with an empty profile.
  name: opt(nonEmpty()),
  backupPrefix: opt(nonEmpty()),
  timezone,
  encryption: z.enum(ENCRYPTIONS).default("none"),
  anchorHourUtc: intIn(16, 0, 23),
  dump: dumpGroup,
  integrity: integrityGroup,
  retention: retentionGroup,
  drill: drillGroup,
  verifyDurable: verifyDurableGroup,
  staleness: stalenessGroup,
  slack: slackGroup,
  dashboard: dashboardGroup,
  credentials: credentialsGroup,
}).strict(); // reject unknown/typo'd or misplaced keys (e.g. Slack creds under slack:) instead of silently dropping them

export type Profile = z.infer<typeof profileSchema>;

// ── Per-task required-credential refinements ─────────────────────────────────

type Ctx = z.core.$RefinementCtx;
const miss = (ctx: Ctx, path: (string | number)[], message: string) =>
  ctx.addIssue({ code: "custom", path, message });

function requireNameAndPrefix(v: Profile, ctx: Ctx): void {
  if (!v.name) miss(ctx, ["name"], "must be set");
  if (!v.backupPrefix) miss(ctx, ["backupPrefix"], "must be set");
}
function requireR2(v: Profile, ctx: Ctx): void {
  const r = v.credentials.r2;
  if (!r.accountId) miss(ctx, ["credentials", "r2", "accountId"], "must be set");
  if (!r.bucket) miss(ctx, ["credentials", "r2", "bucket"], "must be set");
  if (!r.accessKeyId) miss(ctx, ["credentials", "r2", "accessKeyId"], "must be set");
  if (!r.secretAccessKey) miss(ctx, ["credentials", "r2", "secretAccessKey"], "must be set");
}
function requireSlackChannel(v: Profile, ctx: Ctx): void {
  if (v.credentials.slackToken && !v.credentials.slackChannel) {
    miss(ctx, ["credentials", "slackChannel"], "required when the Slack bot token (SLACK_BOT_TOKEN) is set");
  }
}

export const backupSchema = profileSchema
  .superRefine(requireNameAndPrefix)
  .superRefine(requireR2)
  .superRefine(requireSlackChannel)
  .superRefine((v, ctx) => {
    if (!v.credentials.databaseUrl) miss(ctx, ["credentials", "databaseUrl"], "must be set");
    if (v.encryption === "age" && !v.credentials.age.recipient) {
      miss(ctx, ["credentials", "age", "recipient"], "required when encryption=age");
    }
    if (v.integrity.verifyAfterUpload && v.encryption === "age" && !v.credentials.age.identity) {
      miss(ctx, ["credentials", "age", "identity"], "required when integrity.verify-after-upload is on and encryption=age");
    }
  });

function requireDrillCreds(v: Profile, ctx: Ctx): void {
  requireNameAndPrefix(v, ctx);
  requireR2(v, ctx);
  requireSlackChannel(v, ctx);
  if (!v.drill.rowCountTable) miss(ctx, ["drill", "rowCountTable"], "must be set");
  if (!v.credentials.drillDatabaseUrl) miss(ctx, ["credentials", "drillDatabaseUrl"], "must be set");
  if (!v.credentials.liveDatabaseUrl) miss(ctx, ["credentials", "liveDatabaseUrl"], "must be set");
  if (v.encryption === "age" && !v.credentials.age.identity) {
    miss(ctx, ["credentials", "age", "identity"], "required when encryption=age (needed to decrypt .age objects)");
  }
}

export const drillSchema = profileSchema.superRefine(requireDrillCreds);
export const verifyDurableSchema = profileSchema.superRefine(requireDrillCreds);

function requireValidStalenessSlot(v: Profile, ctx: Ctx): void {
  // grace must sit strictly inside the slot: if grace ≥ slot, dueMs always lands in a LATER slot than the
  // one `now` is in, so the current slot can never be flagged overdue — slot-based self-heal silently never
  // fires and recovery falls back to the slow max-age-hours backstop. See lib/schedule.ts slotState().
  if (v.staleness.graceMinutes >= v.staleness.slotMinutes) {
    miss(
      ctx,
      ["staleness", "graceMinutes"],
      `must be less than staleness.slot-minutes (${v.staleness.slotMinutes}); otherwise the current slot can ` +
        `never be flagged overdue and slot-based self-heal silently falls back to the max-age-hours backstop`,
    );
  }
}

export const stalenessSchema = profileSchema
  .superRefine(requireNameAndPrefix)
  .superRefine(requireR2)
  .superRefine(requireSlackChannel)
  .superRefine(requireValidStalenessSlot);

/**
 * Dashboard config. R2_BUCKET / name requirements depend on RUNTIME flags (reading logs from R2 vs
 * --sample/--logdir; --upload), so the schema is parameterised: build-dashboard.ts passes the flags it
 * parsed; doctor validates with fromR2:true.
 */
export function dashboardSchema(opts: { fromR2?: boolean; upload?: boolean } = {}) {
  return profileSchema.superRefine((v, ctx) => {
    if (opts.fromR2 && !v.name) miss(ctx, ["name"], "required to read logs from R2");
    if (opts.fromR2 && !v.credentials.r2.bucket) {
      miss(ctx, ["credentials", "r2", "bucket"], "required to read logs from R2 (or pass --sample / --logdir)");
    }
    if (opts.upload && !v.credentials.dashboardR2.bucket) {
      miss(ctx, ["credentials", "dashboardR2", "bucket"], "required with --upload");
    }
  });
}

// ── Typed outputs ────────────────────────────────────────────────────────────

export type BackupConfig = Profile;
export type DrillConfig = Profile;
export type VerifyDurableConfig = Profile;
export type StalenessConfig = Profile;
export type DashboardConfig = Profile;

// ── retention → dashboard RetentionMap ───────────────────────────────────────

export function retentionFromConfig(r: Profile["retention"]): RetentionMap {
  return { "2hourly": r.grandson, daily: r.son, weekly: r.father, monthly: r.grandfather };
}

// ── Error reporting (secret-safe; YAML fields as kebab, credentials as their ENV name) ───

const camelToKebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Credential object-path → the ENV var users actually set (so the report points at the right place). */
const CRED_ENV: Record<string, string> = {
  "credentials.databaseUrl": "PG_BACKUP_DATABASE_URL",
  "credentials.drillDatabaseUrl": "DRILL_DATABASE_URL",
  "credentials.liveDatabaseUrl": "PG_LIVE_DATABASE_URL",
  "credentials.r2.accountId": "R2_ACCOUNT_ID",
  "credentials.r2.bucket": "R2_BUCKET",
  "credentials.r2.accessKeyId": "R2_ACCESS_KEY_ID",
  "credentials.r2.secretAccessKey": "R2_SECRET_ACCESS_KEY",
  "credentials.dashboardR2.bucket": "DASHBOARD_R2_BUCKET",
  "credentials.dashboardR2.accessKeyId": "DASHBOARD_R2_ACCESS_KEY_ID",
  "credentials.dashboardR2.secretAccessKey": "DASHBOARD_R2_SECRET_ACCESS_KEY",
  "credentials.age.recipient": "AGE_RECIPIENT",
  "credentials.age.identity": "AGE_IDENTITY",
  "credentials.slackToken": "SLACK_BOT_TOKEN",
  "credentials.slackChannel": "SLACK_CHANNEL",
  "credentials.heartbeatUrl": "HEARTBEAT_URL",
  "credentials.alertWebhookUrl": "ALERT_WEBHOOK_URL",
};

function displayPath(path: readonly (string | number | symbol)[]): string {
  const dotted = path.map(String).join(".");
  if (dotted.startsWith("credentials.")) return CRED_ENV[dotted] ?? dotted.split(".").map(camelToKebab).join(".");
  return path.map((s) => (typeof s === "number" ? `[${s}]` : camelToKebab(String(s)))).join(".");
}

export function reportConfigError(err: z.ZodError): void {
  process.stderr.write("✗ config validation failed:\n\n");
  for (const issue of err.issues) {
    process.stderr.write(`  ✗ ${displayPath(issue.path) || "(profile root)"} — ${issue.message}\n`);
  }
  process.stderr.write("\nFix the field(s) above in your profile (YAML) or environment, then re-run.\n");
}

/**
 * Validate the merged profile object (YAML config + env credentials) against `schema`. On failure,
 * print every issue at once (names only — secret-safe) and exit 1; on success, return the typed config.
 * Shared by the tasks AND doctor, so the two can never drift.
 */
export function loadConfig<T extends z.ZodType>(schema: T): z.infer<T> {
  const res = schema.safeParse(buildRawProfile());
  if (!res.success) {
    reportConfigError(res.error);
    process.exit(1);
  }
  return res.data;
}

export const loadBackupConfig = (): BackupConfig => loadConfig(backupSchema);
export const loadDrillConfig = (): DrillConfig => loadConfig(drillSchema);
export const loadVerifyDurableConfig = (): VerifyDurableConfig => loadConfig(verifyDurableSchema);
export const loadStalenessConfig = (): StalenessConfig => loadConfig(stalenessSchema);
export const loadDashboardConfig = (opts?: { fromR2?: boolean; upload?: boolean }): DashboardConfig =>
  loadConfig(dashboardSchema(opts));

// ── Validated singleton (for the libs that read config globally: slack.ts / runlog.ts / logStore.ts) ──
// Validated with the loose-cred profileSchema (creds optional — those libs null-guard, and a task's
// load*Config already enforced the creds it needs by the time these run).

let cached: Profile | null = null;

/** The cached, validated profile; lazily validates + caches on first read. Exits 1 on a bad profile. */
export function getProfile(): Profile {
  if (cached) return cached;
  cached = loadConfig(profileSchema);
  return cached;
}

/**
 * Tolerant peer of getProfile() for BEST-EFFORT readers (slack.ts, backup's config-failure path):
 * returns the cached profile, else a loose-schema safeParse (which passes even when a task's required
 * *credential* is missing — those are optional here), else null. NEVER exits — so a Slack ❌ can still
 * be posted when a task-level config error has already been detected. Caches a successful parse.
 */
export function peekProfile(): Profile | null {
  if (cached) return cached;
  const res = profileSchema.safeParse(buildRawProfile());
  if (res.success) cached = res.data;
  return res.success ? res.data : null;
}

/** Test seam — inject a fully-formed Profile, or null to clear the cache (so it doesn't leak between tests). */
export function setProfileForTest(p: Profile | null): void {
  cached = p;
}
