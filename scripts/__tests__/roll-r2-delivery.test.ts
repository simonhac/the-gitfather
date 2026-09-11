import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The regression test for the incident of 2026-09-10: a rotation completed, was escrowed and
// published, and recorded nothing — because roll-r2-token.ts read its run-log environment from the
// shell, which CI sets and a laptop does not.
//
// Asserting the SHAPE of the environment the tool builds is not enough. Discard the value at the
// call site and a construction-only test stays green while the defect returns. So this drives the
// real CLI, with stand-in `op`/`gh`/`rclone` on PATH, and asserts on what the LOGGER was actually
// invoked with — delivery, not construction.

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "roll-r2-token.ts");
const FAKES = join(here, "fixtures", "roll-r2-fakes");

const TOKEN = "the-token-value";
const KEYID = "0123456789abcdef0123456789abcdef";

function runRotation(): { status: number | null; stdout: string; stderr: string; rcloneLog: string } {
  const state = mkdtempSync(join(tmpdir(), "roll-delivery-"));
  const profile = join(state, "p.yaml");
  writeFileSync(profile, "name: boost\n");
  mkdirSync(join(state, "op"), { recursive: true });

  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, "--vault", "v", "--bucket", "boost-pg-backups", "--account-id", "acc123", "--repo", "o/r"],
    {
      encoding: "utf8",
      // Blank third line = derive the secret from the token value.
      input: `${TOKEN}\n${KEYID}\n\n`,
      env: {
        ...process.env,
        PATH: `${FAKES}:${process.env.PATH ?? ""}`,
        FAKE_STATE: state,
        PROFILE: profile,
        // Deliberately absent: R2_BUCKET and every RCLONE_CONFIG_R2_*. A laptop shell has none of
        // them, and supplying them here would test the harness instead of the tool.
        R2_BUCKET: undefined,
        RCLONE_CONFIG_R2_ACCESS_KEY_ID: undefined,
        RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: undefined,
        RCLONE_CONFIG_R2_ENDPOINT: undefined,
      } as NodeJS.ProcessEnv,
    },
  );
  const logPath = join(state, "rclone.log");
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    rcloneLog: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

test("the run-log call receives the verified credential, from a shell that has none", () => {
  const { status, stderr, rcloneLog } = runRotation();
  assert.equal(status, 0, `the rotation should succeed\n${stderr}`);

  const logCalls = rcloneLog.split("\n").filter((l) => l.includes("_log/"));
  assert.ok(logCalls.length > 0, `the run-log was never written to:\n${rcloneLog}`);
  for (const call of logCalls) {
    assert.match(call, /R2_BUCKET=boost-pg-backups/, "the logger got the bucket");
    assert.match(call, new RegExp(`KEYID=${KEYID}`), "the logger got the credential");
  }
});

test("a rotation that records successfully does NOT warn", () => {
  const { stderr } = runRotation();
  assert.doesNotMatch(stderr, /was NOT recorded/, `unexpected warning:\n${stderr}`);
});
