import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubArchiveWeek, readIndexDir, readArchiveIndexDir } from "../lib/archiveIndex.js";

// A real line as archive-table.ts writes it, digests and all — the thing that must NOT reach the page.
const RECORD = {
  label: "2026-W02",
  state: "pruned",
  parts: [
    { part: 1, role: "full", rowCount: 409, fingerprint: { n: 409, digest: "f9c32969d7e4caf3" } },
  ],
  updatedAt: "2026-09-09T12:53:31.644Z",
};

const dirWith = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "index-test-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};
const lines = (...records: unknown[]): string => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

// ── scrubArchiveWeek ─────────────────────────────────────────────────────────

test("scrubArchiveWeek: keeps the week, its state and its row count", () => {
  assert.deepEqual(scrubArchiveWeek("api_logs", RECORD), {
    table: "api_logs", week: "2026-W02", state: "pruned", rows: 409,
  });
});

test("scrubArchiveWeek: rows come from the ACTIVE part, not the newest or the sum", () => {
  // A superseded part is a stale snapshot of the same window; a supplement is late-arriving rows
  // recorded after a prune. Neither is "what this week holds" — the highest-numbered `full` is.
  const rows = (parts: unknown[]) => scrubArchiveWeek("t", { ...RECORD, state: "archived", parts })!.rows;
  assert.equal(rows([
    { part: 1, role: "superseded", rowCount: 100, fingerprint: { n: 100, digest: "a" } },
    { part: 2, role: "full", rowCount: 140, fingerprint: { n: 140, digest: "b" } },
  ]), 140);
  assert.equal(rows([
    { part: 1, role: "full", rowCount: 409, fingerprint: { n: 409, digest: "a" } },
    { part: 2, role: "supplement", rowCount: 3, fingerprint: { n: 3, digest: "b" } },
  ]), 409, "a supplement does not raise the week's count");
  assert.equal(rows([]), 0, "a zero-row week is archived, and says so");
});

test("scrubArchiveWeek: anything that is not a real week record is dropped, not guessed at", () => {
  for (const bad of [null, undefined, 42, "2026-W02", {}, { label: "2026-W02" },
                     { label: "2026-W02", state: "deleted", parts: [] },
                     { label: 2026, state: "archived", parts: [] }]) {
    assert.equal(scrubArchiveWeek("t", bad), null, JSON.stringify(bad));
  }
});

test("scrubArchiveWeek: nothing private survives the scrub", () => {
  // The privacy pin. Serialised rather than key-walked, so a nested field cannot slip through.
  const json = JSON.stringify(scrubArchiveWeek("api_logs", RECORD));
  for (const secret of ["fingerprint", "digest", "f9c32969d7e4caf3", "part", "role", "updatedAt"]) {
    assert.ok(!json.includes(secret), `"${secret}" must not reach the published payload`);
  }
});

// ── readIndexDir ─────────────────────────────────────────────────────────────

test("readIndexDir: reads every year file in the directory", () => {
  // A 52-week window straddling New Year touches more than one ISO year, which is why the whole
  // directory is copied rather than a guessed year.
  const dir = dirWith({
    "api_logs-2025.jsonl": lines({ ...RECORD, label: "2025-W51" }, { ...RECORD, label: "2025-W52" }),
    "api_logs-2026.jsonl": lines({ ...RECORD, label: "2026-W01", state: "archived" }),
    "README.txt": "not a jsonl file",
  });
  assert.deepEqual(readIndexDir(dir, "api_logs").map((w) => w.week), ["2025-W51", "2025-W52", "2026-W01"]);
});

test("readIndexDir: a malformed line costs that line, not the build", () => {
  const dir = dirWith({
    "t-2026.jsonl": `${JSON.stringify(RECORD)}\n{"label":"2026-W03",\n\n${JSON.stringify({ ...RECORD, label: "2026-W04" })}\n`,
  });
  assert.deepEqual(readIndexDir(dir, "t").map((w) => w.week), ["2026-W02", "2026-W04"]);
});

test("readIndexDir: a missing directory is an ordinary state — that table was never archived", () => {
  assert.deepEqual(readIndexDir(join(tmpdir(), "definitely-not-here-9f2a"), "t"), []);
});

test("readIndexDir: a week rewritten in place keeps its LATEST state", () => {
  // The index is a materialised view, not a log: archive-table.ts rewrites a year file when a week
  // moves from archived to pruned.
  const dir = dirWith({
    "t-2026.jsonl": lines({ ...RECORD, label: "2026-W02", state: "archived" }, { ...RECORD, label: "2026-W02", state: "pruned" }),
  });
  assert.deepEqual(readIndexDir(dir, "t"), [{ table: "t", week: "2026-W02", state: "pruned", rows: 409 }]);
});

test("readArchiveIndexDir: --logdir reads <logdir>/_index/<table>/, and is silent when absent", () => {
  const logdir = mkdtempSync(join(tmpdir(), "logdir-"));
  mkdirSync(join(logdir, "_index", "api_logs"), { recursive: true });
  writeFileSync(join(logdir, "_index", "api_logs", "api_logs-2026.jsonl"), lines(RECORD));
  assert.deepEqual(readArchiveIndexDir(logdir, ["api_logs", "audit_events"]), [
    { table: "api_logs", week: "2026-W02", state: "pruned", rows: 409 },
  ]);
});
