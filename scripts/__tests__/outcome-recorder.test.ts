import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startOutcome } from "../lib/outcomeRecorder.js";
import { drainOutcomeAlerts, outcomeAlert } from "../lib/outcomeSink.js";
import { MAX_ALERT_TEXT, MAX_ALERTS, OUTCOME_PREFIX, parseJobOutcome, parseOutcomeKey } from "../lib/jobOutcome.js";
import { setProfileForTest } from "../lib/config.js";
import { commandExists } from "../lib/proc.js";

// The recorder is what every job now says about itself on the way out. These pin the three things
// the scheduler relies on: a run's verdict (`ok`) can never read as a success when it was not, the
// record always parses, and it lands where the Worker looks — including from a real process exit.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const noRclone = commandExists("rclone") ? false : "rclone not on PATH";

const ENV_KEYS = [
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITFATHER_JOB_ID",
  "R2_BUCKET",
  "RUNLOG_RCLONE_REMOTE",
  "RCLONE_CONFIG_OT_TYPE",
  "PROFILE",
];

/**
 * Run `fn` with exactly `vars` set among ENV_KEYS (the rest unset — CI sets GITHUB_RUN_ID itself),
 * and with the process-global sink and profile cache empty on the way in and out.
 */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  drainOutcomeAlerts();
  setProfileForTest(null);
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    drainOutcomeAlerts();
    setProfileForTest(null);
  }
}

const ACTIONS = { GITHUB_RUN_ID: "18000000001", GITHUB_RUN_ATTEMPT: "2", GITFATHER_JOB_ID: "52000000001" };
const T0 = Date.parse("2026-09-27T03:15:00.000Z");

/** A clock that reads T0 first (startOutcome) and advances 1.5 s per read after that. */
function clock(): () => Date {
  let t = T0 - 1500;
  return () => new Date((t += 1500));
}

const recorder = (job: Parameters<typeof startOutcome>[0] = "backup") => startOutcome(job, { now: clock(), register: false });

test("off Actions (no GITHUB_RUN_ID) it records nothing", () => {
  for (const env of [{}, { GITHUB_RUN_ID: "" }, { GITHUB_RUN_ID: "not-a-run" }] as Record<string, string>[]) {
    withEnv(env, () => {
      const rec = recorder();
      rec.setName("boost");
      rec.alert("page", "backup_failed", "x");
      assert.equal(rec.build(1), null);
      assert.equal(rec.flush(1), false);
    });
  }
});

test("a clean exit records ok, with the run's identity, origin and summary — and the Worker can parse it", () => {
  withEnv(ACTIONS, () => {
    const rec = recorder();
    rec.setName("boost");
    rec.setOrigin("manual");
    rec.summary({ kind: "backup", tiers: ["intraday", "daily"], bytes: 4096 });
    const o = rec.build(0);
    assert.deepEqual(o, {
      version: 1,
      source: "job",
      job: "backup",
      name: "boost",
      runId: "18000000001",
      runAttempt: 2,
      jobId: "52000000001",
      ok: true,
      exitCode: 0,
      startedAt: "2026-09-27T03:15:00.000Z",
      finishedAt: "2026-09-27T03:15:01.500Z",
      durationMs: 1500,
      origin: "manual",
      summary: { kind: "backup", tiers: ["intraday", "daily"], bytes: 4096 },
      alerts: [],
    });
    assert.deepEqual(parseJobOutcome(JSON.stringify(o)), o);
  });
});

test("a warn keeps the run ok; a page makes it not ok even at exit 0", () => {
  withEnv(ACTIONS, () => {
    const rec = recorder("durableVerify");
    rec.setName("boost");
    rec.alert("warn", "credential_rotation", "R2 is 400 days old");
    const o = rec.build(0);
    assert.equal(o?.ok, true);
    assert.deepEqual(o?.alerts, [{ severity: "warn", code: "credential_rotation", text: "R2 is 400 days old" }]);
  });
  withEnv(ACTIONS, () => {
    const rec = recorder("durableVerify");
    rec.setName("boost");
    rec.alert("page", "hash_mismatch", "hash mismatch daily/x");
    const o = rec.build(0);
    assert.equal(o?.ok, false);
    assert.equal(o?.exitCode, 0);
    assert.deepEqual(o?.alerts.map((a) => a.code), ["hash_mismatch"], "no synthetic exit_ page on top of a real one");
  });
});

test("an alert raised straight into the sink (as reportConfigError does) is recorded, and suffices as the reason", () => {
  withEnv(ACTIONS, () => {
    const rec = recorder();
    rec.setName("boost");
    outcomeAlert("page", "config_invalid", "config validation failed: R2_BUCKET");
    const o = rec.build(1);
    assert.equal(o?.ok, false);
    assert.deepEqual(o?.alerts, [{ severity: "page", code: "config_invalid", text: "config validation failed: R2_BUCKET" }]);
  });
});

test("a non-zero exit that recorded no page still pages exit_<code> — a crash never reads as a success", () => {
  withEnv(ACTIONS, () => {
    const rec = recorder();
    rec.setName("boost");
    const o = rec.build(2);
    assert.equal(o?.ok, false);
    assert.equal(o?.alerts.length, 1);
    assert.equal(o?.alerts[0].severity, "page");
    assert.equal(o?.alerts[0].code, "exit_2");
    assert.match(o!.alerts[0].text, /exited with code 2 without recording a reason/);
  });
  withEnv(ACTIONS, () => {
    // A warn is not a reason for a failure.
    const rec = recorder();
    rec.setName("boost");
    rec.alert("warn", "manual_drill_overdue", "drill overdue");
    assert.deepEqual(rec.build(1)?.alerts.map((a) => `${a.severity}:${a.code}`), ["warn:manual_drill_overdue", "page:exit_1"]);
  });
});

test("130 / 143 (the scripts' SIGINT / SIGTERM handlers) read as a cancel or a timeout", () => {
  for (const code of [130, 143]) {
    withEnv(ACTIONS, () => {
      const rec = recorder();
      rec.setName("boost");
      const [a] = rec.build(code)!.alerts;
      assert.equal(a.code, `exit_${code}`);
      assert.match(a.text, new RegExp(`cancelled or timed out \\(exit ${code}\\)`));
    });
  }
});

test("a junk job id reads as null and a junk attempt as 1, rather than losing the record", () => {
  for (const [jobId, attempt] of [["", "x"], ["abc", "0"], ["12 34", "-1"]]) {
    withEnv({ GITHUB_RUN_ID: "5", GITHUB_RUN_ATTEMPT: attempt, GITFATHER_JOB_ID: jobId }, () => {
      const rec = recorder();
      rec.setName("boost");
      const o = rec.build(0);
      assert.equal(o?.jobId, null, jobId);
      assert.equal(o?.runAttempt, 1, attempt);
      assert.ok(parseJobOutcome(JSON.stringify(o)));
    });
  }
});

test("alerts are clamped to what the Worker accepts (e.g. pg-classify's hyphenated codes)", () => {
  withEnv(ACTIONS, () => {
    const rec = recorder();
    rec.setName("boost");
    rec.alert("page", "auth-rejected", "e".repeat(MAX_ALERT_TEXT + 1000));
    const [a] = rec.build(1)!.alerts;
    assert.equal(a.code, "auth_rejected");
    assert.equal(a.text.length, MAX_ALERT_TEXT);
  });
});

test(`more than ${MAX_ALERTS} alerts: the tail collapses into one 'truncated' alert that keeps its severity`, () => {
  withEnv(ACTIONS, () => {
    const rec = recorder("archive");
    rec.setName("boost");
    for (let i = 0; i < 25; i++) rec.alert("warn", "archive_anomaly", `anomaly ${i}`);
    rec.alert("page", "archive_refusal", "the one that matters is last");
    const o = rec.build(1)!;
    assert.equal(o.alerts.length, MAX_ALERTS);
    assert.deepEqual(o.alerts[0], { severity: "warn", code: "archive_anomaly", text: "anomaly 0" });
    const last = o.alerts[MAX_ALERTS - 1];
    assert.equal(last.code, "truncated");
    assert.equal(last.severity, "page", "a dropped page must still page");
    assert.match(last.text, /^7 more alert\(s\) not shown/);
    assert.equal(o.ok, false);
    assert.ok(parseJobOutcome(JSON.stringify(o)));
  });
  withEnv(ACTIONS, () => {
    const rec = recorder("archive");
    rec.setName("boost");
    for (let i = 0; i < 25; i++) rec.alert("warn", "archive_anomaly", `anomaly ${i}`);
    const last = rec.build(0)!.alerts.at(-1)!;
    assert.equal(last.severity, "warn");
    assert.match(last.text, /^6 more alert\(s\)/);
  });
});

test("build() can run more than once without losing or duplicating alerts", () => {
  withEnv(ACTIONS, () => {
    const rec = recorder();
    rec.setName("boost");
    rec.alert("warn", "a", "first");
    assert.equal(rec.build(0)?.alerts.length, 1);
    rec.alert("warn", "b", "second");
    assert.deepEqual(rec.build(0)?.alerts.map((a) => a.code), ["a", "b"]);
  });
});

test("the name: setName wins; else the profile's, read raw even when the profile fails validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "gf-outcome-profile-"));
  try {
    const valid = join(dir, "valid.yaml");
    writeFileSync(valid, "name: from-profile\n");
    // A profile that fails even the loose schema — the config_invalid run is the one that most needs naming.
    const invalid = join(dir, "invalid.yaml");
    writeFileSync(invalid, "name: still-named\nanchor-hour-utc: 99\nslack:\n  channel: C0123456789\n");

    withEnv({ ...ACTIONS, PROFILE: valid }, () => {
      const rec = recorder();
      assert.equal(rec.build(0)?.name, "from-profile");
      rec.setName("explicit");
      assert.equal(rec.build(0)?.name, "explicit");
    });
    withEnv({ ...ACTIONS, PROFILE: invalid }, () => assert.equal(recorder().build(1)?.name, "still-named"));
    withEnv({ ...ACTIONS, PROFILE: join(dir, "missing.yaml") }, () => assert.equal(recorder().build(1)?.name, ""));
    withEnv(ACTIONS, () => assert.equal(recorder().build(1)?.name, ""));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flush writes nothing when it cannot name or place the record, or is suppressed", () => {
  const dir = mkdtempSync(join(tmpdir(), "gf-outcome-"));
  const local = { R2_BUCKET: dir, RUNLOG_RCLONE_REMOTE: "ot", RCLONE_CONFIG_OT_TYPE: "local" };
  try {
    withEnv({ ...ACTIONS, ...local }, () => assert.equal(recorder().flush(1), false, "no name"));
    withEnv({ ...ACTIONS, ...local }, () => {
      const rec = recorder();
      rec.setName("not a name/../x");
      assert.equal(rec.flush(1), false, "a name that cannot form a key");
    });
    withEnv(ACTIONS, () => {
      const rec = recorder();
      rec.setName("boost");
      assert.equal(rec.flush(0), false, "no R2_BUCKET");
    });
    withEnv({ ...ACTIONS, ...local }, () => {
      const rec = recorder("archive");
      rec.setName("boost");
      rec.suppress("--dry-run=store leaves the store untouched");
      assert.equal(rec.flush(0), false);
    });
    assert.deepEqual(readdirSync(dir), [], "nothing reached the store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The single record under a local "bucket", parsed, with its key. */
function readOnlyRecord(dir: string): { key: string; body: string } {
  const outDir = join(dir, OUTCOME_PREFIX);
  const files = readdirSync(outDir);
  assert.equal(files.length, 1, `one record, got: ${files.join(", ")}`);
  return { key: `${OUTCOME_PREFIX}${files[0]}`, body: readFileSync(join(outDir, files[0]), "utf8") };
}

test("flush uploads the record to <bucket>/_status/_outcome/<key> — once", { skip: noRclone }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gf-outcome-"));
  try {
    withEnv({ ...ACTIONS, R2_BUCKET: dir, RUNLOG_RCLONE_REMOTE: "ot", RCLONE_CONFIG_OT_TYPE: "local" }, () => {
      const rec = recorder("restoreDrill");
      rec.setName("my_db"); // an underscore in the name must survive the key round trip
      rec.alert("page", "drill_failed", "restored public.things is empty/zero or unreadable (intraday/x.dump)");
      assert.equal(rec.flush(1), true);
      assert.equal(rec.flush(1), false, "once only — the exit listener and an explicit call cannot double-write");

      const { key, body } = readOnlyRecord(dir);
      assert.deepEqual(parseOutcomeKey(key), {
        stamp: "20260927T031500Z",
        runId: "18000000001",
        runAttempt: 2,
        job: "restoreDrill",
        name: "my_db",
      });
      const o = parseJobOutcome(body);
      assert.ok(o, body);
      assert.equal(o.ok, false);
      assert.equal(o.exitCode, 1);
      assert.equal(o.jobId, "52000000001");
      assert.deepEqual(o.alerts.map((a) => a.code), ["drill_failed"]);
      assert.ok(!existsSync(join(tmpdir(), `outcome-${process.pid}.json`)), "the staging file is removed");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real process exit writes the record from the exit listener", { skip: noRclone }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gf-outcome-exit-"));
  try {
    const script = join(dir, "job.ts");
    writeFileSync(
      script,
      [
        `import { startOutcome } from ${JSON.stringify(pathToFileURL(join(REPO, "scripts", "lib", "outcomeRecorder.ts")).href)};`,
        `const rec = startOutcome("durableVerify");`,
        `rec.setName("exit-path");`,
        `rec.alert("warn", "credential_rotation", "R2 is 400 days old");`,
        `process.exit(3);`,
        "",
      ].join("\n"),
    );
    const bucket = join(dir, "bucket");
    const r = spawnSync(join(REPO, "node_modules", ".bin", "tsx"), [script], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_RUN_ID: "77",
        GITHUB_RUN_ATTEMPT: "1",
        GITFATHER_JOB_ID: "",
        PROFILE: "",
        R2_BUCKET: bucket,
        RUNLOG_RCLONE_REMOTE: "ot",
        RCLONE_CONFIG_OT_TYPE: "local",
      },
    });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stdout, /outcome: recorded FAILED → _status\/_outcome\/\d{8}T\d{6}Z_77_1_durableVerify_exit-path\.json/);
    const o = parseJobOutcome(readOnlyRecord(bucket).body);
    assert.ok(o);
    assert.equal(o.exitCode, 3);
    assert.equal(o.ok, false);
    assert.deepEqual(o.alerts.map((a) => `${a.severity}:${a.code}`), ["warn:credential_rotation", "page:exit_3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
