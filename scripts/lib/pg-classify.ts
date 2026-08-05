// ─────────────────────────────────────────────────────────────────────────────
// Classify a failed pg_dump / psql run from libpq's *documented* error text.
//
// Why this module exists: the failure alert used to carry the literal string "pg_dump failed"
// and nothing else, because runToFile() wired the child's stderr straight to the Actions log
// and never captured it. On 2026-08-04 a database password rotated out-of-band, the backup
// went down for 16 hours, and the watchdog paged @here every 10 minutes — ~96 pages, not one
// of which named the cause. Naming it turns that outage into a one-minute secret update.
//
// The rule (borrowed from the caller repos' own house style): classify ONLY from strings the
// vendor documents, and let anything unmatched stay loud and generic. A catch-all branch that
// asserts a specific meaning is how a transient network reset becomes "your key is rejected".
// The 429/5xx-equivalent arms here cannot be forced against a live database, which is exactly
// why the table is pure, exported and unit-tested rather than inlined at the call site.
//
// Everything returned by classifyPgFailure() is Slack-bound, so it is redacted first — a dump
// failure is one of the few places a connection string can surface in an error.
// ─────────────────────────────────────────────────────────────────────────────

export type PgFailureCode =
  | "auth-rejected"
  | "pooler-tenant"
  | "client-version"
  | "dns"
  | "connection-reset"
  | "saturated"
  | "timeout"
  | "privileges"
  | "runner-disk"
  | "unknown";

export interface PgFailure {
  code: PgFailureCode;
  /** Operator-facing statement of the fault. Safe to post to Slack (credential-redacted). */
  message: string;
  /**
   * Could an identical retry plausibly succeed with no human involved? Drives the fail-fast
   * probe (a non-transient class means the dump cannot succeed, so don't spend the dump on
   * rediscovering it) and keeps a genuine network blip retry-eligible. `unknown` is NOT
   * transient — never guess a verdict that would suppress a page.
   */
  transient: boolean;
}

/**
 * Causes that mean the client never obtained a session at all. They are the only ones safe to
 * act on from a cheap pre-dump probe: if the probe could not connect, pg_dump cannot either.
 * A statement-level cause (privileges, timeout) says nothing certain about the rest of the dump,
 * so it must NOT short-circuit one — pg_dump stays the real verdict.
 */
export const CONNECTION_LEVEL_CODES: readonly PgFailureCode[] = ["auth-rejected", "pooler-tenant", "dns"];

export function isConnectionLevel(code: PgFailureCode): boolean {
  return CONNECTION_LEVEL_CODES.includes(code);
}

interface Rule {
  code: PgFailureCode;
  /** Must be un-flagged (no /g): a global regex carries lastIndex between calls and misfires. */
  match: RegExp;
  transient: boolean;
  message: string;
}

// Ordered: the specific, actionable causes first. Every pattern below is a string Postgres,
// Supavisor or pg_dump documents and emits verbatim.
const RULES: Rule[] = [
  {
    code: "auth-rejected",
    match: /password authentication failed for user/i,
    transient: false,
    message:
      "credential rejected by the database — PG_BACKUP_DATABASE_URL is stale (the password was " +
      "rotated); re-derive the connection string and update the secret",
  },
  {
    code: "pooler-tenant",
    match: /tenant or user not found/i,
    transient: false,
    message:
      "the connection pooler rejected the tenant — check the host's region/generation prefix and " +
      "that the username is postgres.<project_ref>, not bare postgres",
  },
  {
    code: "client-version",
    match: /server version mismatch/i,
    transient: false,
    message: "pg_dump is older than the server — raise dump.client-major in the profile",
  },
  {
    code: "dns",
    match: /could not translate host name/i,
    transient: false,
    message:
      "the database host did not resolve — check the host (a Supabase direct host is IPv6-only; " +
      "use the session pooler)",
  },
  {
    code: "privileges",
    match: /permission denied for/i,
    transient: false,
    message: "the backup role is missing a grant — a privilege changed on the database",
  },
  {
    code: "connection-reset",
    match: /ssl connection has been closed unexpectedly|connection reset by peer|ECONNRESET/i,
    transient: true,
    message: "the connection to the database dropped mid-dump",
  },
  {
    code: "saturated",
    match: /too many clients already|remaining connection slots are reserved/i,
    transient: true,
    message: "the database refused the connection — no connection slots free",
  },
  {
    code: "timeout",
    match: /canceling statement due to statement timeout/i,
    transient: true,
    message: "the server cancelled the dump (statement timeout)",
  },
  {
    code: "runner-disk",
    match: /no space left on device/i,
    transient: true,
    message: "the runner ran out of disk while writing the dump",
  },
];

// Masks, not deletions: a redacted line still shows an operator that a credential WAS there,
// which a silently-dropped line does not.
const REDACTIONS: [RegExp, string][] = [
  // `password retrieved from file "/tmp/pg-backup-XXXX/.pgpass-3519-0"` — libpq's own hint line.
  [/password retrieved from file "[^"]*"/gi, 'password retrieved from file "[redacted]"'],
  // scheme://user:secret@host  →  scheme://user:***@host
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]*@/gi, "$1:***@"],
  // keyword/value conninfo and the environment variable
  [/\bpassword\s*=\s*\S+/gi, "password=***"],
  [/\bPGPASSWORD=\S+/g, "PGPASSWORD=***"],
];

/** Mask anything credential-shaped in child stderr before it can reach Slack or the run-log. */
export function redactPgStderr(stderr: string): string {
  let out = stderr ?? "";
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

const TAIL_LINES = 3;
const TAIL_CHARS = 300;

/** Last few non-empty lines, bounded — enough to diagnose, too small to flood a channel. */
function stderrTail(redacted: string): string {
  const lines = redacted
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const tail = lines.slice(-TAIL_LINES).join("; ");
  return tail.length > TAIL_CHARS ? `${tail.slice(0, TAIL_CHARS - 1)}…` : tail;
}

/**
 * Map child stderr to an operator-facing cause. `fallbackLabel` is what an unmatched failure
 * is still called — keep it the same generic phrase the call site used before, so an unknown
 * failure reads exactly as loudly as it always did, just with a tail attached.
 */
export function classifyPgFailure(stderr: string, fallbackLabel = "pg_dump failed"): PgFailure {
  // Redact BEFORE matching, so there is no path on which an unredacted string is returned.
  const redacted = redactPgStderr(stderr ?? "");

  for (const rule of RULES) {
    if (rule.match.test(redacted)) {
      return { code: rule.code, message: rule.message, transient: rule.transient };
    }
  }

  const tail = stderrTail(redacted);
  return {
    code: "unknown",
    message: tail ? `${fallbackLabel}: ${tail}` : fallbackLabel,
    transient: false,
  };
}
