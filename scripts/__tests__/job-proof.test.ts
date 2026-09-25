import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jobProof,
  jobProofKey,
  jobsVerdict,
  owedJobs,
  parseJobProof,
  JOB_PROOF_MAX_AGE_MS,
  type JobCheck,
} from "../lib/jobProof.js";

// CB-299: job proofs replace a push heartbeat per job per project. The Worker's /health/jobs is
// only as honest as these rules — above all, it must never answer 200 for something it did not see.

const NOW = new Date("2026-09-25T00:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => jobProof("durableVerify", "boost", new Date(NOW.getTime() - ms));

test("jobProofKey: sits under _health/<name>/, beside _log/ and _config/", () => {
  assert.equal(jobProofKey("boost", "archive"), "_health/boost/archive.json");
});

test("parseJobProof: round-trips what the publisher writes, and refuses anything else", () => {
  const p = jobProof("archive", "boost", NOW);
  assert.deepEqual(parseJobProof(JSON.stringify(p)), p);
  for (const bad of [null, "", "not json", "[]", JSON.stringify({ ...p, version: 2 }), JSON.stringify({ ...p, job: "backup" }),
    JSON.stringify({ ...p, name: "" }), JSON.stringify({ ...p, provenAt: "yesterday" })]) {
    assert.equal(parseJobProof(bad), null, `should refuse ${String(bad)}`);
  }
});

for (const [name, input, expected] of [
  ["a default client owes durable-verify only (archive is opt-in)", { durableVerify: true, archive: false }, ["durableVerify"]],
  ["an archiving client owes both", { durableVerify: true, archive: true }, ["durableVerify", "archive"]],
  ["…unless THIS database archives nothing", { durableVerify: true, archive: true, archives: false }, ["durableVerify"]],
  ["a legacy config (no `archives`) defers to the roster", { durableVerify: true, archive: true, archives: undefined }, ["durableVerify", "archive"]],
] as const) {
  test(`owedJobs: ${name}`, () => {
    assert.deepEqual(owedJobs(input), expected);
  });
}

const check = (proof: JobCheck["proof"], extra: Partial<JobCheck> = {}): JobCheck => ({ client: "c1", job: "durableVerify", proof, ...extra });

test("jobsVerdict: every proof fresh → 200", () => {
  const v = jobsVerdict([check(ago(2 * HOUR)), check(jobProof("archive", "boost", new Date(NOW.getTime() - 6 * 24 * HOUR)), { job: "archive" })], NOW);
  assert.equal(v.status, 200);
  assert.equal(v.body.failing, 0);
});

for (const [name, c, reason] of [
  ["no proof ever recorded (the CB-299 `pending` case)", check(null), /no proof recorded/],
  ["stale past the job's own window", check(ago(JOB_PROOF_MAX_AGE_MS.durableVerify + 1)), /stale/],
  ["dated in the future", check(ago(-HOUR)), /future/],
  ["the Worker could not look", check(null, { problem: "config listing failed" }), /config listing failed/],
] as const) {
  test(`jobsVerdict: one failing check fails the whole answer — ${name}`, () => {
    const v = jobsVerdict([check(ago(HOUR)), c], NOW);
    assert.equal(v.status, 503);
    assert.equal(v.body.failing, 1);
    assert.match(v.body.checks[1].reason ?? "", reason);
  });
}

test("jobsVerdict: the window is per job — a 3-day-old proof is fine for archive, dead for durable-verify", () => {
  const threeDays = 3 * 24 * HOUR;
  assert.equal(jobsVerdict([check(ago(threeDays), { job: "archive" })], NOW).status, 200);
  assert.equal(jobsVerdict([check(ago(threeDays))], NOW).status, 503);
});

test("jobsVerdict: nothing checked is a 503, never a vacuous 200", () => {
  const v = jobsVerdict([], NOW);
  assert.equal(v.status, 503);
  assert.match(v.body.reason ?? "", /nothing was checked/);
});
