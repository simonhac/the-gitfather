// ─────────────────────────────────────────────────────────────────────────────
// The watchdog config: the slice of a profile the Cloudflare Worker's staleness watchdog needs.
//
// Direction of trust is GitHub → Cloudflare, never the reverse. The backup job — which already holds
// the validated profile and R2 write credentials — PUBLISHES this object to the client's private
// bucket on every run (_config/<name>/watchdog.json); the Worker reads it through its R2 binding.
// The profile in git stays the only hand-edited copy, the Worker never touches GitHub beyond the
// dispatch it already does, and a profile edit takes effect on the next backup run.
//
// Every value here has already passed the backup schema's zod validation (defaults applied, slot /
// grace / backstop relationships checked), so the Worker parses shape only. Node-free: bundled into
// the Worker.
// ─────────────────────────────────────────────────────────────────────────────

export const WATCHDOG_CONFIG_VERSION = 1;

/**
 * The fields the publisher reads — a structural view of a validated Profile (lib/config.ts), spelled out
 * here so this module stays free of config.ts (and therefore of zod / node) for the Worker bundle.
 */
export interface WatchdogSource {
  name?: string;
  backupPrefix?: string;
  timezone: string;
  dump: { minBytes: number };
  staleness: {
    slotMinutes: number;
    graceMinutes: number;
    maxAgeHours: number;
    repageMinutes: number;
    selfHeal: boolean;
    dryRun: boolean;
    healWorkflow: string;
  };
  slack: { alertMention: string };
  dashboard: { url?: string };
  archive?: { tables: readonly unknown[] };
}

/** Where a backup publishes its watchdog config. The Worker lists `_config/` to find every backup in a bucket. */
export const WATCHDOG_CONFIG_PREFIX = "_config/";
export const watchdogConfigKey = (name: string): string => `${WATCHDOG_CONFIG_PREFIX}${name}/watchdog.json`;

export interface WatchdogConfig {
  version: typeof WATCHDOG_CONFIG_VERSION;
  /** profile `name` — object-key basename, Slack header, _status/ and _log/ partition. */
  name: string;
  /** profile `backup-prefix` — the watchdog lists `<backupPrefix>/2hourly/`. */
  backupPrefix: string;
  /** profile `timezone` — the Slack row's day boundary and HH:MM labels. */
  timezone: string;
  slotMinutes: number;
  graceMinutes: number;
  maxAgeHours: number;
  repageMinutes: number;
  /** `dump.min-bytes` — a fresh-but-smaller newest object is broken, not stale. */
  minBytes: number;
  selfHeal: boolean;
  dryRun: boolean;
  /** The caller workflow file self-heal dispatches (`staleness.heal-workflow`). */
  healWorkflow: string;
  /** Slack channel id, or null when Slack is off for this backup. The bot token is a Worker secret. */
  slackChannel: string | null;
  alertMention: string;
  dashboardUrl: string | null;
  /**
   * Whether this database archives any table — so /health/jobs expects an `archive` proof from it
   * only when it does (see jobProof.ts owedJobs). Undefined on configs published before the field.
   */
  archives?: boolean;
  /** ISO-8601 — when this was published (which backup run's view of the profile this is). */
  publishedAt: string;
}

/** Build the publishable object from a validated profile. `slackChannel` honours env SLACK_CHANNEL first. */
export function watchdogConfigFrom(cfg: WatchdogSource, now: Date, slackChannel: string): WatchdogConfig {
  return {
    version: WATCHDOG_CONFIG_VERSION,
    name: cfg.name ?? "",
    backupPrefix: cfg.backupPrefix ?? "",
    timezone: cfg.timezone,
    slotMinutes: cfg.staleness.slotMinutes,
    graceMinutes: cfg.staleness.graceMinutes,
    maxAgeHours: cfg.staleness.maxAgeHours,
    repageMinutes: cfg.staleness.repageMinutes,
    minBytes: cfg.dump.minBytes,
    selfHeal: cfg.staleness.selfHeal,
    dryRun: cfg.staleness.dryRun,
    healWorkflow: cfg.staleness.healWorkflow,
    slackChannel: slackChannel || null,
    alertMention: cfg.slack.alertMention || "<!here>",
    dashboardUrl: cfg.dashboard.url ?? null,
    archives: (cfg.archive?.tables.length ?? 0) > 0,
    publishedAt: now.toISOString(),
  };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Parse a published object. Tolerant of extra keys (a newer publisher), strict about the ones the
 * watchdog cannot run without; anything else → null, which the Worker reports as `no-config` rather
 * than guessing at a cadence.
 */
export function parseWatchdogConfig(raw: string): WatchdogConfig | null {
  if (!raw || !raw.trim()) return null;
  let v: Partial<WatchdogConfig> | null;
  try {
    v = JSON.parse(raw) as Partial<WatchdogConfig> | null;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (v.version !== WATCHDOG_CONFIG_VERSION) return null;
  if (!isStr(v.name) || !isStr(v.backupPrefix) || !isStr(v.timezone)) return null;
  if (!isInt(v.slotMinutes) || v.slotMinutes <= 0 || 1440 % v.slotMinutes !== 0) return null;
  if (!isInt(v.graceMinutes) || v.graceMinutes < 0) return null;
  if (!isInt(v.maxAgeHours) || v.maxAgeHours <= 0) return null;
  if (!isInt(v.repageMinutes) || v.repageMinutes < 0) return null;
  if (!isInt(v.minBytes) || v.minBytes < 0) return null;
  if (typeof v.selfHeal !== "boolean" || typeof v.dryRun !== "boolean") return null;
  if (!isStr(v.healWorkflow)) return null;
  return {
    version: WATCHDOG_CONFIG_VERSION,
    name: v.name,
    backupPrefix: v.backupPrefix.replace(/\/+$/, ""),
    timezone: v.timezone,
    slotMinutes: v.slotMinutes,
    graceMinutes: v.graceMinutes,
    maxAgeHours: v.maxAgeHours,
    repageMinutes: v.repageMinutes,
    minBytes: v.minBytes,
    selfHeal: v.selfHeal,
    dryRun: v.dryRun,
    healWorkflow: v.healWorkflow,
    slackChannel: strOrNull(v.slackChannel),
    alertMention: isStr(v.alertMention) ? v.alertMention : "<!here>",
    dashboardUrl: strOrNull(v.dashboardUrl),
    ...(typeof v.archives === "boolean" ? { archives: v.archives } : {}),
    publishedAt: typeof v.publishedAt === "string" ? v.publishedAt : "",
  };
}
