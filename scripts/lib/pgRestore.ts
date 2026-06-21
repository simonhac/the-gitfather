// ─────────────────────────────────────────────────────────────────────────────
// Classify pg_restore stderr into BENIGN (tolerated) vs SUSPICIOUS (real) errors.
//
// Restoring a provider-managed dump into vanilla Postgres always emits noise: missing
// roles/extensions, ownership/privilege complaints, idempotent "already exists". The drill
// historically tolerated ALL of it by ignoring pg_restore's exit code entirely — which also
// hid genuine failures (decode errors, partial table failures). This encodes that implicit
// tolerance as an explicit, reviewable allow-list so the drill can fail on the UNRECOGNISED
// while still passing on the known-benign. Pure + unit-tested (pgRestore.test.ts).
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
  /^\s*command was:/i,
  /^\s*detail:/i,
  /^\s*context:/i,
  /errors ignored on restore/i, // the trailing summary count line
];

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
 * (or a `pg_restore:`-prefixed line) are considered; pure context lines are dropped. A line that
 * is an error but matches no BENIGN pattern is suspicious.
 */
export function classifyPgRestoreStderr(stderr: string): PgRestoreClassification {
  const benign: string[] = [];
  const suspicious: string[] = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (CONTEXT.some((re) => re.test(line))) continue;
    const looksLikeError = /\b(error|warning|fatal)\b/i.test(line) || /^pg_restore:/i.test(line);
    if (!looksLikeError) continue;
    if (BENIGN.some((re) => re.test(line))) benign.push(line);
    else suspicious.push(line);
  }
  return { benign, suspicious };
}
