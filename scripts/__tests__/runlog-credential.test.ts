import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCredential } from "../runlog.js";
import { commandExists } from "../lib/proc.js";

const rec = { ts: "2026-09-11T04:00:00Z", prefix: "R2", bucket: "b", repo: "o/r", keyIdTail: "9f2c" };

// appendCredential used to return void, so roll-r2-token.ts could not tell a written record from a
// skipped one. Run from an operator's shell — the way it is actually run — the environment it needs
// was absent, so it warned once into a wall of output and recorded nothing. The credential monitor
// then reported `never recorded` every day forever, and no amount of correctly rotating cleared it:
// a false alarm shaped exactly like the true one it exists to raise. The boolean is what lets the
// caller say so.

test("reports FALSE when the log cannot be resolved — the condition that went unnoticed", () => {
  delete process.env.PROFILE;
  delete process.env.R2_BUCKET;
  assert.equal(appendCredential(rec), false);
});

test("reports FALSE rather than THROWING when $PROFILE cannot be read", () => {
  // buildRawProfile reads and parses a file, so a missing or malformed profile raises. That escaped
  // a module whose contract is never-throws, and in roll-r2-token.ts it surfaced as a fatal error
  // AFTER the secrets were published — a completed rotation reported as a failure.
  const dir = mkdtempSync(join(tmpdir(), "runlog-bad-"));
  process.env.R2_BUCKET = dir;
  try {
    process.env.PROFILE = join(dir, "does-not-exist.yaml");
    assert.equal(appendCredential(rec), false, "missing profile");
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "name: [unclosed\n");
    process.env.PROFILE = bad;
    assert.equal(appendCredential(rec), false, "malformed profile");
  } finally {
    delete process.env.PROFILE;
    delete process.env.R2_BUCKET;
  }
});

// rclone is REQUIRED, not optional. A skip here would be a check that passes without proving
// anything — and nothing would notice, because it would still print as a pass.
test("reports TRUE and writes the record when the environment is set", () => {
  assert.ok(commandExists("rclone"), "rclone is required for the run-log integration test");
  {
    // A `local` rclone remote exercises the REAL append path — lsf, read-modify-write, copyto —
    // against a directory instead of R2. Everything but the endpoint is the production code path.
    const dir = mkdtempSync(join(tmpdir(), "runlog-cred-"));
    const profile = join(dir, "p.yaml");
    writeFileSync(profile, "name: boost\n");
    mkdirSync(join(dir, "_log", "boost"), { recursive: true }); // rclone lsf errors on a missing local dir
    process.env.PROFILE = profile;
    process.env.R2_BUCKET = dir;
    process.env.RUNLOG_RCLONE_REMOTE = "local";
    process.env.RCLONE_CONFIG_LOCAL_TYPE = "local";

    try {
      assert.equal(appendCredential(rec), true);
      const f = join(dir, "_log", "boost", "credentials-2026-09.jsonl");
      assert.ok(existsSync(f), "the record landed in credentials-<YYYY-MM>.jsonl");
      assert.deepEqual(JSON.parse(readFileSync(f, "utf8").trim()), rec, "byte-for-byte what was passed in");
    } finally {
      delete process.env.PROFILE;
      delete process.env.R2_BUCKET;
      delete process.env.RUNLOG_RCLONE_REMOTE;
      delete process.env.RCLONE_CONFIG_LOCAL_TYPE;
    }
  }
});
