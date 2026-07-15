// ─────────────────────────────────────────────────────────────────────────────
// Classify pg_restore stderr into BENIGN (tolerated) vs SUSPICIOUS (real) errors.
//
// Restoring a provider-managed dump into vanilla Postgres always emits noise: missing
// roles/extensions, ownership/privilege complaints, idempotent "already exists". The drill
// historically tolerated ALL of it by ignoring pg_restore's exit code entirely — which also
// hid genuine failures (decode errors, partial table failures). This encodes that implicit
// tolerance as an explicit, reviewable allow-list so the drill can fail on the UNRECOGNISED
// while still passing on the known-benign. Pure + unit-tested (pgRestore.test.ts).
//
// pg_restore (PG12+) prefixes its continuation lines with `pg_restore: ` (e.g.
// `pg_restore: detail: Command was: <sql>`); older clients emit them bare/indented
// (`    Command was: <sql>`). Both are recognised as context, and the — possibly MULTI-LINE — SQL
// body echoed after a `Command was:` header is skipped too (raw DDL/data, not diagnostics; a column
// named `error text` or an enum value `'ERROR'` must not read as an error). Every genuine diagnostic
// stays `pg_restore:`-prefixed, so a new prefixed line (or a blank line) always ends the echo.
// ─────────────────────────────────────────────────────────────────────────────

export interface PgRestoreClassification {
  /** Tolerated managed-schema / vanilla-restore noise. */
  benign: string[];
  /** Unrecognised error/warning lines — a real restore problem. */
  suspicious: string[];
}

/** Pure context/progress lines — not errors in themselves, ignored entirely. */
const CONTEXT: RegExp[] = [
  /^pg_restore: (while|from|connecting|processing|creating|implied|executing|launching|entering|finished)/i,
  /^(pg_restore:\s*)?(detail|context|hint):/i, // continuation lines — modern `pg_restore: detail:` + bare `Detail:`
  /errors ignored on restore/i, // the trailing summary count line
];

/** A `Command was:` echo header (old bare form + PG15+ `pg_restore: detail: Command was:`); its SQL body follows. */
const COMMAND_WAS = /^(pg_restore:\s*)?(detail:\s*)?command was:/i;

/** Error/warning lines we tolerate (managed-schema / vanilla-target noise). */
const BENIGN: RegExp[] = [
  /does not exist/i, // referenced role / extension / schema absent in vanilla target
  /must be owner of/i,
  /must be superuser/i,
  /permission denied for (schema|relation|table|sequence|database|type|function|language)/i,
  /already exists/i, // idempotent re-create
  /no privileges (were|could be) granted/i,
  /could not (open|find|load) extension/i,
  /extension ".*" is not available/i,
  /unrecognized configuration parameter/i, // GUCs the managed provider set, vanilla PG lacks
];

/**
 * Split pg_restore stderr into benign vs suspicious. Only lines that look like an error/warning
 * (or a `pg_restore:`-prefixed line) are considered; pure context lines — including the raw SQL body
 * echoed after a `Command was:` header — are dropped. A line that is an error but matches no BENIGN
 * pattern is suspicious.
 */
export function classifyPgRestoreStderr(stderr: string): PgRestoreClassification {
  const benign: string[] = [];
  const suspicious: string[] = [];
  let inCommandEcho = false; // inside a `Command was:` SQL echo, whose (multi-line) body is raw SQL/data
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (!line) {
      inCommandEcho = false; // a blank line ends any command echo
      continue;
    }
    const isPgRestoreLine = /^pg_restore:/i.test(line);
    if (isPgRestoreLine) inCommandEcho = false; // a fresh diagnostic line ends any command echo
    if (COMMAND_WAS.test(line)) {
      inCommandEcho = true; // drop the header; skip its SQL body below until the next diagnostic/blank line
      continue;
    }
    if (inCommandEcho && !isPgRestoreLine) continue; // raw SQL/data body of a command echo — never a diagnostic
    if (CONTEXT.some((re) => re.test(line))) continue;
    const looksLikeError = /\b(error|warning|fatal)\b/i.test(line) || isPgRestoreLine;
    if (!looksLikeError) continue;
    if (BENIGN.some((re) => re.test(line))) benign.push(line);
    else suspicious.push(line);
  }
  return { benign, suspicious };
}
