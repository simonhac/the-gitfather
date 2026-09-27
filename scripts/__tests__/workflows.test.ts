import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// The reusable workflows are the engine's public API: consumers call them @main, so a mistake here
// ships to every client on its next run. These pin the notify contract (the last step tells the
// scheduler a run finished) and the clean break from job-side Slack — and that the caller examples in
// the docs only pass what the workflows declare, since passing an undeclared input fails the run.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

/** The four job workflows, and the script each one's main step runs. */
const JOB_WORKFLOWS: Record<string, string> = {
  "pg-backup.yml": "scripts/backup-pg-to-r2.ts",
  "pg-durable-verify.yml": "scripts/verify-durable-pg.ts",
  "pg-restore-drill.yml": "scripts/restore-drill-pg.ts",
  "pg-archive.yml": "scripts/archive-table.ts",
};

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  "timeout-minutes"?: number;
}
interface Job {
  permissions?: unknown;
  steps: Step[];
}
interface Declared {
  description?: string;
  type?: string;
  required?: boolean;
  default?: unknown;
}
interface Workflow {
  permissions?: unknown;
  on: { workflow_call: { inputs?: Record<string, Declared>; secrets?: Record<string, Declared> } };
  jobs: Record<string, Job>;
}

const load = (file: string): Workflow => parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
const onlyJob = (wf: Workflow): Job => {
  const jobs = Object.values(wf.jobs);
  assert.equal(jobs.length, 1);
  return jobs[0];
};

test("every job workflow ends with the SAME notify step, which always runs and never fails the job", () => {
  const runs = new Map<string, string>();
  for (const file of Object.keys(JOB_WORKFLOWS)) {
    const steps = onlyJob(load(file)).steps;
    const last = steps[steps.length - 1];
    assert.equal(last.name, "Notify the-gitfather scheduler", file);
    assert.equal(last.if, "always()", `${file}: must run after a failed step too`);
    assert.equal(last["timeout-minutes"], 2, file);
    assert.deepEqual(last.env, { NOTIFY_URL: "${{ inputs.notify_url }}" }, file);
    assert.ok(last.run, file);
    assert.ok(last.run.trimEnd().endsWith("exit 0"), `${file}: the notify step must never fail the job`);
    assert.match(last.run, /audience=the-gitfather/);
    assert.match(last.run, /::add-mask::/, `${file}: the OIDC token is masked in the log`);
    assert.doesNotMatch(last.run, /secrets\./, `${file}: authenticated by OIDC — nothing stored`);
    assert.equal(steps.filter((s) => s.name === last.name).length, 1, file);
    runs.set(file, last.run);
  }
  const [first, ...rest] = [...runs.entries()];
  for (const [file, run] of rest) assert.equal(run, first[1], `${file}'s notify step differs from ${first[0]}'s`);
});

test("no permissions: key — the caller's id-token grant flows down; declaring one would force it on every caller", () => {
  for (const file of Object.keys(JOB_WORKFLOWS)) {
    const wf = load(file);
    assert.equal(wf.permissions, undefined, `${file}: workflow-level permissions`);
    for (const [id, job] of Object.entries(wf.jobs)) assert.equal(job.permissions, undefined, `${file}: job ${id} permissions`);
  }
});

test("jobs hold no Slack token, webhook or GitHub token any more", () => {
  for (const file of Object.keys(JOB_WORKFLOWS)) {
    for (const step of onlyJob(load(file)).steps) {
      for (const key of Object.keys(step.env ?? {})) {
        assert.ok(!key.startsWith("SLACK_"), `${file} / ${step.name ?? step.uses}: ${key}`);
        assert.ok(key !== "ALERT_WEBHOOK_URL" && key !== "GITHUB_TOKEN", `${file} / ${step.name ?? step.uses}: ${key}`);
      }
    }
  }
});

test("the main step names its job for the outcome record's log link", () => {
  for (const [file, script] of Object.entries(JOB_WORKFLOWS)) {
    const main = onlyJob(load(file)).steps.filter((s) => s.run?.includes(script));
    assert.equal(main.length, 1, `${file}: one step runs ${script}`);
    assert.equal(main[0].env?.GITFATHER_JOB_ID, "${{ job.check_run_id }}", file);
  }
});

test("notify_url is declared; the retired Slack inputs/secrets stay declared (callers pin @main) but deprecated", () => {
  for (const file of Object.keys(JOB_WORKFLOWS)) {
    const { inputs = {}, secrets = {} } = load(file).on.workflow_call;
    assert.equal(inputs.notify_url?.type, "string", file);
    assert.equal(inputs.notify_url?.required, false, file);
    assert.equal(inputs.notify_url?.default, "", file);
    for (const d of [inputs.slack_channel, secrets.SLACK_BOT_TOKEN, secrets.ALERT_WEBHOOK_URL]) {
      assert.ok(d, `${file}: removing a declaration fails every caller that still passes it`);
      assert.equal(d.required, false, file);
      assert.match(d.description ?? "", /^DEPRECATED — ignored/, file);
    }
  }
});

// ── the caller examples in docs/wiring-a-consuming-repo.md ───────────────────

interface CallerJob {
  permissions?: Record<string, string>;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown> | "inherit";
}

function docCallerJobs(): { workflow: string; job: CallerJob }[] {
  const md = readFileSync(join(REPO, "docs", "wiring-a-consuming-repo.md"), "utf8");
  const blocks = [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  const out: { workflow: string; job: CallerJob }[] = [];
  for (const block of blocks) {
    const doc = parse(block) as { jobs?: Record<string, CallerJob> } | null;
    for (const job of Object.values(doc?.jobs ?? {})) {
      const m = /^simonhac\/the-gitfather\/\.github\/workflows\/([\w.-]+\.yml)@/.exec(job.uses ?? "");
      if (m) out.push({ workflow: m[1], job });
    }
  }
  return out;
}

test("docs: every with: / secrets: key in a caller example is declared by the workflow it calls", () => {
  const jobs = docCallerJobs();
  assert.ok(jobs.length >= 5, `expected the caller examples, found ${jobs.length}`);
  for (const { workflow, job } of jobs) {
    const { inputs = {}, secrets = {} } = load(workflow).on.workflow_call;
    for (const k of Object.keys(job.with ?? {})) assert.ok(k in inputs, `${workflow}: with.${k} is not a declared input`);
    if (job.secrets && job.secrets !== "inherit") {
      for (const k of Object.keys(job.secrets)) assert.ok(k in secrets, `${workflow}: secrets.${k} is not a declared secret`);
    }
  }
});

test("docs: the job-workflow examples grant id-token, pass notify_url, and pass nothing Slack", () => {
  const jobs = docCallerJobs().filter(({ workflow }) => workflow in JOB_WORKFLOWS);
  assert.deepEqual([...new Set(jobs.map((j) => j.workflow))].sort(), Object.keys(JOB_WORKFLOWS).sort());
  for (const { workflow, job } of jobs) {
    assert.equal(job.permissions?.["id-token"], "write", workflow);
    assert.equal(job.with?.notify_url, "${{ vars.GITFATHER_NOTIFY_URL }}", workflow);
    assert.ok(!("slack_channel" in (job.with ?? {})), workflow);
    const secrets = job.secrets === "inherit" ? {} : (job.secrets ?? {});
    for (const k of ["SLACK_BOT_TOKEN", "ALERT_WEBHOOK_URL"]) assert.ok(!(k in secrets), `${workflow}: ${k}`);
  }
});
