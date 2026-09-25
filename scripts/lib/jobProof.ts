// ─────────────────────────────────────────────────────────────────────────────
// Job proofs: a dead-man's switch that is PULLED, not pushed.
//
// A Better Stack heartbeat per job per project does not scale — three projects × (backup, verify,
// archive) plus the scheduler is ten slots, the whole free plan, and every new job or project costs
// another. It also fails silently in a way CB-299 found four times over: the ping URL is an optional
// secret the caller must pass explicitly, so "never wired" reads exactly like "opted out", and a
// heartbeat that has never had a first beat sits in `pending` and cannot alert.
//
// So instead, a job that has PROVEN its claim writes a tiny marker to its own bucket at
// `_health/<name>/<job>.json` — at precisely the point it would have pinged a heartbeat, gated by
// the same verdict. The scheduler Worker, which already binds every client's bucket, reads them all
// and answers `/health/jobs` with 503 when any owed proof is missing or too old. ONE uptime monitor
// on that URL covers every job in every project, and a new project costs nothing.
//
// A marker is only as strong as its gate, so the gates are the same ones the heartbeats used:
// durable-verify writes it only when verifyHeartbeatVerdict allows ("these backups are provably
// restorable"), the archiver only on a clean real run that met its floor.
//
// Node-free: bundled into the Worker, and imported by the Actions-side publisher.
// ─────────────────────────────────────────────────────────────────────────────

export const JOB_PROOF_VERSION = 1;

/** The jobs that publish a proof. Backups are watched by the staleness watchdog instead. */
export type ProofJob = "durableVerify" | "archive";
export const PROOF_JOBS: readonly ProofJob[] = ["durableVerify", "archive"];

export const JOB_PROOF_PREFIX = "_health/";
export const jobProofKey = (name: string, job: ProofJob): string => `${JOB_PROOF_PREFIX}${name}/${job}.json`;

const HOUR_MS = 3_600_000;

/**
 * How old a proof may be before its job counts as dead. Each tolerates the job's own period plus a
 * margin for a slow run — NOT a missed run, because a missed run is the thing being watched for.
 *
 *   durableVerify  daily at 18:30 UTC      → 30h: a single missed day fires the next night. The
 *                  margin absorbs a run that finishes late (restores vary, and Actions queues).
 *   archive        weekly, Sunday 19:30    → 8d: a missed Sunday fires the following Monday.
 */
export const JOB_PROOF_MAX_AGE_MS: Record<ProofJob, number> = {
  durableVerify: 30 * HOUR_MS,
  archive: 8 * 24 * HOUR_MS,
};

export interface JobProof {
  version: typeof JOB_PROOF_VERSION;
  job: ProofJob;
  /** profile `name` — the _health/ partition, as for _log/ and _config/. */
  name: string;
  /** ISO-8601 — when the job proved its claim. */
  provenAt: string;
}

export function jobProof(job: ProofJob, name: string, now: Date): JobProof {
  return { version: JOB_PROOF_VERSION, job, name, provenAt: now.toISOString() };
}

/** Parse a stored proof; anything malformed is null, which the verdict treats as missing. */
export function parseJobProof(raw: string | null): JobProof | null {
  if (!raw || !raw.trim()) return null;
  let v: Partial<JobProof> | null;
  try {
    v = JSON.parse(raw) as Partial<JobProof> | null;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (v.version !== JOB_PROOF_VERSION) return null;
  if (!PROOF_JOBS.includes(v.job as ProofJob)) return null;
  if (typeof v.name !== "string" || !v.name) return null;
  if (typeof v.provenAt !== "string" || Number.isNaN(Date.parse(v.provenAt))) return null;
  return { version: JOB_PROOF_VERSION, job: v.job as ProofJob, name: v.name, provenAt: v.provenAt };
}

/**
 * Which proofs a database owes: the jobs its client is rostered for, except that `archive` is also
 * skipped when the published config says this database archives nothing — a client with two
 * databases may archive only one. `archives` is undefined on configs published before the field
 * existed, and then the roster alone decides.
 */
export function owedJobs(o: { durableVerify: boolean; archive: boolean; archives?: boolean }): ProofJob[] {
  const out: ProofJob[] = [];
  if (o.durableVerify) out.push("durableVerify");
  if (o.archive && o.archives !== false) out.push("archive");
  return out;
}

/**
 * One (client, database, job) the Worker expected a proof for. `problem` means the Worker could
 * not LOOK — the bucket listing failed, no config is published — which fails the check just as a
 * missing proof does: "could not look" is not evidence of health.
 */
export interface JobCheck {
  /** The roster's opaque client id — the only identifier allowed in this PUBLIC response. */
  client: string;
  job: ProofJob;
  proof: JobProof | null;
  problem?: string;
}

export interface JobCheckResult {
  client: string;
  job: ProofJob;
  ok: boolean;
  provenAt: string | null;
  ageHours: number | null;
  reason?: string;
}

export interface JobsVerdict {
  status: number;
  body: { ok: boolean; checked: number; failing: number; checks: JobCheckResult[]; reason?: string };
}

function judge(c: JobCheck, now: Date): JobCheckResult {
  const base = { client: c.client, job: c.job };
  if (c.problem) return { ...base, ok: false, provenAt: null, ageHours: null, reason: c.problem };
  if (c.proof === null) return { ...base, ok: false, provenAt: null, ageHours: null, reason: "no proof recorded" };
  const age = now.getTime() - Date.parse(c.proof.provenAt);
  const ageHours = Math.round((age / HOUR_MS) * 10) / 10;
  const r = { ...base, provenAt: c.proof.provenAt, ageHours };
  // A future stamp would otherwise read healthy for maxAge beyond that instant (same rule as /health).
  if (age < 0) return { ...r, ok: false, reason: "proof is dated in the future" };
  if (age > JOB_PROOF_MAX_AGE_MS[c.job]) return { ...r, ok: false, reason: "proof is stale" };
  return { ...r, ok: true };
}

/**
 * The /health/jobs answer. 200 only when there was at least one check AND every one passed.
 *
 * Zero checks is a 503, not a vacuous 200: an empty roster, or clients whose buckets publish no
 * config, would otherwise read as "all jobs healthy" while nothing was looked at — the census-floor
 * rule ("found nothing" and "couldn't see" must not be the same sentence).
 */
export function jobsVerdict(checks: readonly JobCheck[], now: Date): JobsVerdict {
  const results = checks.map((c) => judge(c, now));
  const failing = results.filter((r) => !r.ok).length;
  if (results.length === 0) {
    return { status: 503, body: { ok: false, checked: 0, failing: 0, checks: [], reason: "no job proofs are owed — nothing was checked" } };
  }
  const ok = failing === 0;
  return { status: ok ? 200 : 503, body: { ok, checked: results.length, failing, checks: results } };
}
