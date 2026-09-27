// ─────────────────────────────────────────────────────────────────────────────
// GitHub Actions run context from the default env vars.
//
// A dependency-free LEAF module: it imports nothing, so runlog.ts (in scripts/) and anything in lib/
// can depend on it without risking an import cycle.
//
// Reads the GitHub-default env vars present in every Actions step:
//   GITHUB_RUN_ID / GITHUB_SERVER_URL / GITHUB_REPOSITORY   → the run page URL
// Off-Actions (any of them unset) everything degrades to null — callers fall back to plain text.
//
// There is no per-JOB log link here any more: jobs no longer post to Slack, and the scheduler Worker
// builds that link itself from the run it was notified about (the job id rides in the outcome record).
// ─────────────────────────────────────────────────────────────────────────────

/** Run identifiers from the default env vars (null off-Actions). */
export function githubRunInfo(): { runId: string | null; runUrl: string | null } {
  const runId = process.env.GITHUB_RUN_ID || null;
  const runUrl =
    runId && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
      : null;
  return { runId, runUrl };
}
