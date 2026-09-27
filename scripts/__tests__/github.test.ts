import { test } from "node:test";
import assert from "node:assert/strict";
import { githubRunInfo } from "../lib/github.js";

test("githubRunInfo builds the run URL from the default env vars (null when any is unset)", () => {
  const keys = ["GITHUB_RUN_ID", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY"] as const;
  const orig = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.GITHUB_RUN_ID = "123";
    process.env.GITHUB_SERVER_URL = "https://github.com";
    process.env.GITHUB_REPOSITORY = "o/r";
    assert.deepEqual(githubRunInfo(), { runId: "123", runUrl: "https://github.com/o/r/actions/runs/123" });
    delete process.env.GITHUB_REPOSITORY; // any var missing → no run URL
    assert.deepEqual(githubRunInfo(), { runId: "123", runUrl: null });
    delete process.env.GITHUB_RUN_ID; // off-Actions → nothing at all
    assert.deepEqual(githubRunInfo(), { runId: null, runUrl: null });
  } finally {
    for (const k of keys) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
});
