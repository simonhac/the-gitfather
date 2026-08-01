// ─────────────────────────────────────────────────────────────────────────────
// appendArchive's read-modify-write really APPENDS.
//
// Object stores have no append, so runlog.ts emulates one: read the current month's file, add a
// line, PUT the whole thing back. The failure mode that matters is not cost, it is CLOBBERING — a
// naive version reads "" on a hiccup and writes back a file containing only the newest line,
// silently destroying the month's history. These tests drive the real code path through an rclone
// LOCAL remote (rclone treats a directory as a backend), so no R2 credentials are involved.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists } from "../lib/proc.js";
import type { LogArchive } from "../lib/backupTypes.js";

const skip = commandExists("rclone") ? false : "rclone not on PATH";

/** Point runlog.ts at a directory instead of R2, then import it fresh so it reads this env. */
async function withLocalRemote<T>(dir: string, fn: (mod: typeof import("../runlog.js")) => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  process.env.RUNLOG_RCLONE_REMOTE = "lt";
  process.env.RCLONE_CONFIG_LT_TYPE = "local";
  process.env.R2_BUCKET = dir; // an absolute path is a perfectly good "bucket" for a local remote
  process.env.PROFILE = "";
  const profile = join(dir, "p.yaml");
  writeFileSync(profile, "name: archtest\n");
  process.env.PROFILE = profile;
  // S3/R2 have no directories: `rclone lsf` on a prefix that holds nothing returns exit 0 and an
  // empty listing, which is how the very first append of a new month succeeds in production. A LOCAL
  // remote is different — lsf on a missing directory is an ERROR, and runlog (correctly) treats a
  // failed listing as "store unreachable, do not risk clobbering" and skips. Pre-creating the
  // directory is what makes the local backend behave like the object store it is standing in for.
  mkdirSync(join(dir, "_log", "archtest"), { recursive: true });
  try {
    // Cache-busted so each test gets a module instance that re-reads the env above.
    return await fn(await import(`../runlog.js?t=${Date.now()}${Math.random()}`));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const record = (n: number): Omit<LogArchive, "runId" | "runUrl"> => ({
  ts: `2026-08-0${n}T19:30:00.000Z`,
  ok: true,
  table: "public.api_logs",
  mode: "both",
  dryRun: "none",
  weeksArchived: n,
  rowsArchived: n * 100,
  weeksPruned: n,
  rowsPruned: n * 100,
  bytes: n * 1024,
  refusals: 0,
  anomalies: 0,
  error: null,
  durationMs: 1234,
});

const logPath = (dir: string): string => join(dir, "_log", "archtest", "archives-2026-08.jsonl");

test("appendArchive: successive appends accumulate — the month's history is preserved", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gf-runlog-"));
  try {
    await withLocalRemote(dir, async ({ appendArchive }) => {
      appendArchive(record(1));
      assert.ok(existsSync(logPath(dir)), "the first append must create the month's file");

      appendArchive(record(2));
      appendArchive(record(3));

      const lines = readFileSync(logPath(dir), "utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, 3, "each append adds a line rather than replacing the file");
      assert.deepEqual(
        lines.map((l) => JSON.parse(l).weeksArchived),
        [1, 2, 3],
        "and they stay in write order",
      );
      const first = JSON.parse(lines[0]);
      assert.equal(first.table, "public.api_logs");
      assert.equal(first.rowsPruned, 100);
      assert.equal(first.mode, "both");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendArchive: a pre-existing file with no trailing newline is not corrupted", { skip }, async () => {
  // A hand-edited or truncated file must not fuse its last line onto the new one.
  const dir = mkdtempSync(join(tmpdir(), "gf-runlog-"));
  try {
    await withLocalRemote(dir, async ({ appendArchive }) => {
      const p = logPath(dir);
      rmSync(p, { force: true });
      writeFileSync(p, `${JSON.stringify({ ts: "pre-existing", ok: true })}`); // NO trailing \n

      appendArchive(record(9));

      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, 2, "the missing newline must be repaired, not ignored");
      assert.equal(JSON.parse(lines[0]).ts, "pre-existing", "the earlier record survives verbatim");
      assert.equal(JSON.parse(lines[1]).weeksArchived, 9);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendArchive: never throws when the store is unreachable", { skip }, async () => {
  // Best-effort is load-bearing: an archive run must not fail — still less half-fail after deleting
  // rows — because a log write did not land.
  const dir = mkdtempSync(join(tmpdir(), "gf-runlog-"));
  try {
    await withLocalRemote(dir, async ({ appendArchive }) => {
      process.env.RCLONE_CONFIG_LT_TYPE = "s3";
      process.env.RCLONE_CONFIG_LT_ENDPOINT = "http://127.0.0.1:1"; // nothing is listening
      process.env.R2_BUCKET = "nope";
      const started = Date.now();
      assert.doesNotThrow(() => appendArchive(record(1)));
      // Not just "did not throw" — it must also RETURN PROMPTLY. runlog's rclone calls are clamped
      // (see BOUNDED) precisely so a dead endpoint cannot stall a job that has already deleted rows.
      assert.ok(Date.now() - started < 90_000, `best-effort append took ${Date.now() - started}ms`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
