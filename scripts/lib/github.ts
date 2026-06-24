// ─────────────────────────────────────────────────────────────────────────────
// GitHub Actions run/job context from the default env vars + (best-effort) the REST API.
//
// A dependency-free LEAF module: it imports nothing, so both slack.ts (in lib/) and runlog.ts
// (in scripts/) can depend on it without risking an import cycle.
//
// Reads the GitHub-default env vars present in every Actions step:
//   GITHUB_RUN_ID / GITHUB_SERVER_URL / GITHUB_REPOSITORY   → the run page URL
//   GITHUB_RUN_ATTEMPT / RUNNER_NAME / GITHUB_API_URL        → identify THIS job for the job-log URL
//   GITHUB_TOKEN | GH_TOKEN                                  → auth for the jobs REST API (needs actions:read)
// Off-Actions (any of the run vars unset) everything degrades to "" / null — callers fall back to
// plain text.
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

let logUrlPromise: Promise<string> | undefined;

/**
 * Best link to THIS run's logs for a failure alert:
 *   - the per-JOB log page when it can be resolved (needs a token + actions:read), else
 *   - the run page (runUrl), else
 *   - "" (not running in Actions).
 * Memoized (one API call per process — durable-verify pages repeatedly) and best-effort: never throws.
 */
export function githubLogUrl(): Promise<string> {
  return (logUrlPromise ??= resolveLogUrl());
}

/** Test seam — drop the memoized result so a sibling test can re-resolve under different env. */
export function resetGithubLogUrlForTest(): void {
  logUrlPromise = undefined;
}

async function resolveLogUrl(): Promise<string> {
  const { runUrl } = githubRunInfo();
  if (!runUrl) return ""; // not in Actions
  const jobUrl = await resolveJobUrl();
  return jobUrl || runUrl; // the job-log page when resolved, else the run page
}

/**
 * The html_url of THIS job (the `/actions/runs/<id>/job/<id>` log page), or "" when it can't be
 * resolved. Lists the run's jobs and picks the in-progress job on our runner (runner_name is unique
 * per hosted job — robust when a reusable-workflow run holds several jobs), falling back to the sole
 * job. Never throws.
 */
async function resolveJobUrl(): Promise<string> {
  const runId = process.env.GITHUB_RUN_ID;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!runId || !repo || !token) return "";
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  const runner = process.env.RUNNER_NAME;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${api}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "the-gitfather",
      },
      signal: controller.signal,
    });
    if (!res.ok) return "";
    const body = (await res.json().catch(() => ({}))) as {
      jobs?: { status?: string; runner_name?: string | null; html_url?: string | null }[];
    };
    const jobs = body.jobs ?? [];
    const me =
      jobs.find((j) => j.status === "in_progress" && runner && j.runner_name === runner) ??
      (jobs.length === 1 ? jobs[0] : undefined);
    return me?.html_url || "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
