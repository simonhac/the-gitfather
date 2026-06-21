// ─────────────────────────────────────────────────────────────────────────────
// Profile (YAML) loading for the backup tooling.
//
// A profile is a single nested YAML file (profiles/*.yaml) holding ALL project config in
// kebab-case (idiomatic YAML / GitHub-Actions feel). Credentials are NEVER in the file —
// they come from the environment (GitHub secrets). This module:
//   1. parses $PROFILE (yaml),
//   2. deep-maps kebab-case keys → camelCase (so the zod schema + typed Profile are camelCase
//      and code uses dot access — no cfg["max-age-hours"]),
//   3. merges credentials from the environment into a `credentials` group (buildRawProfile),
//   4. bridges DISPLAY_TZ into process.env (bridgeDisplayTz) — called by bootEnv as the FIRST
//      import so the module-load Intl formatters in backupTypes/backupHistory/slack pick up the tz.
//
// IMPORTANT: this module imports ONLY `yaml` + `node:fs` — never config.ts/backupTypes.ts — so that
// importing it (from bootEnv) does NOT evaluate backupTypes.ts before bridgeDisplayTz() has run.
// Validation + the typed `getProfile()` singleton live in config.ts (the validation layer).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** kebab-case (or snake) key → camelCase. */
function toCamel(key: string): string {
  return key.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Recursively camelCase every object key (arrays/scalars pass through unchanged). A `null` value is
 * DROPPED, not kept: in YAML a bare key with no value (`retention:` / `min-bytes:`) parses to null, and
 * the intent is "unset → use the default". Dropping it makes the key absent so zod's defaults/.prefault
 * fire (otherwise null would be rejected by object groups, or silently coerced to 0 by numeric fields).
 */
export function deepCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCamel);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue; // bare YAML key → treat as unset
      out[toCamel(k)] = deepCamel(v);
    }
    return out;
  }
  return value;
}

/** Parse the $PROFILE YAML file → camelCased config object ({} when PROFILE is unset). */
function loadProfileConfig(path: string | undefined = process.env.PROFILE): Record<string, unknown> {
  if (!path) return {};
  const parsed = parse(readFileSync(path, "utf8"));
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `profile ${path} must be a YAML mapping (key: value), got ${Array.isArray(parsed) ? "a list" : typeof parsed}`,
    );
  }
  return deepCamel(parsed) as Record<string, unknown>;
}

/** Credentials assembled from the environment (GitHub secrets) — never from the profile file. */
function credentialsFromEnv(): Record<string, unknown> {
  const e = process.env;
  return {
    databaseUrl: e.PG_BACKUP_DATABASE_URL,
    drillDatabaseUrl: e.DRILL_DATABASE_URL,
    liveDatabaseUrl: e.PG_LIVE_DATABASE_URL,
    r2: {
      accountId: e.R2_ACCOUNT_ID,
      bucket: e.R2_BUCKET,
      accessKeyId: e.R2_ACCESS_KEY_ID,
      secretAccessKey: e.R2_SECRET_ACCESS_KEY,
    },
    dashboardR2: {
      bucket: e.DASHBOARD_R2_BUCKET,
      accessKeyId: e.DASHBOARD_R2_ACCESS_KEY_ID,
      secretAccessKey: e.DASHBOARD_R2_SECRET_ACCESS_KEY,
    },
    age: { recipient: e.AGE_RECIPIENT, identity: e.AGE_IDENTITY },
    slackToken: e.SLACK_BOT_TOKEN,
    slackChannel: e.SLACK_CHANNEL,
    heartbeatUrl: e.HEARTBEAT_URL,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
  };
}

/**
 * The unvalidated, merged profile object: camelCased YAML config + credentials from env. Each task's
 * loader (lib/config.ts) validates this against its schema. The file owns config; env owns credentials
 * — disjoint namespaces, so there's no clobbering. Re-read each call (cheap; keeps tests deterministic).
 */
export function buildRawProfile(): Record<string, unknown> {
  return { ...loadProfileConfig(), credentials: credentialsFromEnv() };
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set process.env.DISPLAY_TZ from the profile's `timezone` BEFORE backupTypes.ts captures it at module
 * load. Only sets a VALID IANA tz — a typo is left for config validation to report nicely (rather than an
 * ugly Intl throw when the formatters build). No-op (leaves the UTC default) when unset/invalid.
 */
export function bridgeDisplayTz(): void {
  const tz = loadProfileConfig().timezone;
  if (typeof tz === "string" && isValidTz(tz)) process.env.DISPLAY_TZ = tz;
}
