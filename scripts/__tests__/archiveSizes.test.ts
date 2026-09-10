import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArchiveObjectKey, sizeIndexFrom, patchIndexLine, patchIndexFile } from "../lib/archiveSizes.js";
import { LocalStore } from "../lib/store.js";
import { scrubArchiveWeek, readArchiveIndexDir } from "../lib/archiveIndex.js";

// A real index line as writeIndexYear emits it: compact JSON, no bytes, digests and all.
const LINE = JSON.stringify({
  label: "2026-W02",
  state: "pruned",
  parts: [{ part: 1, role: "full", rowCount: 409, fingerprint: { n: 409, digest: "f9c32969d7e4caf3" } }],
  updatedAt: "2026-09-09T12:53:31.644Z",
});

// ── Key parsing ──────────────────────────────────────────────────────────────

test("parseArchiveObjectKey: reads the week and part off the tail", () => {
  assert.deepEqual(parseArchiveObjectKey("archive/api_logs/2026/boost-api_logs-2026-W02-p001.ndjson.zst.age"), {
    week: "2026-W02", part: 1, ext: "ndjson.zst.age",
  });
  assert.deepEqual(parseArchiveObjectKey("archive/api_logs/2026/boost-api_logs-2026-W02-p012.manifest.json"), {
    week: "2026-W02", part: 12, ext: "manifest.json",
  });
});

test("parseArchiveObjectKey: a hyphenated project or table name cannot confuse it", () => {
  // Anchoring on the tail rather than splitting on "-" is the whole reason this is a function.
  const ref = parseArchiveObjectKey("p/t/2026/my-app-2-prod-audit-events-2026-W53-p003.ndjson.age");
  assert.deepEqual(ref, { week: "2026-W53", part: 3, ext: "ndjson.age" });
});

test("parseArchiveObjectKey: anything that is not an archive part is not guessed at", () => {
  for (const k of ["archive/api_logs/_index/api_logs-2026.jsonl", "archive/api_logs/2026/notes.txt",
                   "archive/api_logs/2026/boost-api_logs-2026-W02.ndjson", ""]) {
    assert.equal(parseArchiveObjectKey(k), null, k);
  }
});

test("sizeIndexFrom: manifests are not counted as the week's size", () => {
  const sizes = sizeIndexFrom([
    { key: "p/t/2026/b-t-2026-W02-p001.ndjson.age", bytes: 4096 },
    { key: "p/t/2026/b-t-2026-W02-p001.manifest.json", bytes: 812 },
    { key: "p/t/_index/t-2026.jsonl", bytes: 300 },
  ]);
  assert.deepEqual([...sizes], [["2026-W02#1", 4096]]);
});

// ── Patching ─────────────────────────────────────────────────────────────────

test("patchIndexLine: fills in the size and changes nothing else", () => {
  const sizes = new Map([["2026-W02#1", 4096]]);
  const { text, filled, unmatched } = patchIndexLine(LINE, sizes);
  assert.equal(filled, 1);
  assert.equal(unmatched, 0);
  const before = JSON.parse(LINE);
  const after = JSON.parse(text);
  assert.equal(after.parts[0].bytes, 4096);
  // The property that matters: take the size back out and the record is bit-for-bit the original.
  delete after.parts[0].bytes;
  assert.deepEqual(after, before);
});

test("patchIndexLine: a part with no object keeps no size — 'unknown' is not '0 B'", () => {
  const { text, filled, unmatched } = patchIndexLine(LINE, new Map());
  assert.equal(filled, 0);
  assert.equal(unmatched, 1);
  assert.equal(text, LINE, "an unmatched line is returned exactly as it was read");
  assert.equal("bytes" in JSON.parse(text).parts[0], false);
});

test("patchIndexLine: an existing size is reported, never overwritten", () => {
  const withBytes = JSON.stringify({
    ...JSON.parse(LINE),
    parts: [{ part: 1, role: "full", rowCount: 409, bytes: 11, fingerprint: { n: 409, digest: "a" } }],
  });
  const { text, filled } = patchIndexLine(withBytes, new Map([["2026-W02#1", 4096]]));
  assert.equal(filled, 0, "a backfill does not reconcile");
  assert.equal(JSON.parse(text).parts[0].bytes, 11);
});

test("patchIndexLine: only the ACTIVE part's slot is matched to its own object", () => {
  const twoParts = JSON.stringify({
    label: "2026-W02",
    state: "archived",
    parts: [
      { part: 1, role: "superseded", rowCount: 100, fingerprint: { n: 100, digest: "a" } },
      { part: 2, role: "full", rowCount: 140, fingerprint: { n: 140, digest: "b" } },
    ],
    updatedAt: "2026-09-09T12:53:31.644Z",
  });
  const sizes = new Map([["2026-W02#1", 1000], ["2026-W02#2", 2000]]);
  const parts = JSON.parse(patchIndexLine(twoParts, sizes).text).parts;
  assert.deepEqual(parts.map((p: { bytes: number }) => p.bytes), [1000, 2000], "each part gets its own object");
  // …and the dashboard publishes the active one, so the size it shows is part 2's.
  assert.equal(scrubArchiveWeek("t", JSON.parse(patchIndexLine(twoParts, sizes).text))!.bytes, 2000);
});

test("patchIndexLine: a line that is not a week record is never rewritten", () => {
  for (const bad of ["{not json", "42", '{"label":"2026-W02"}', '{"parts":[]}']) {
    const p = patchIndexLine(bad, new Map([["2026-W02#1", 4096]]));
    assert.equal(p.text, bad, bad);
    assert.equal(p.filled, 0);
    assert.ok(p.skipped, `${bad} should say why it was skipped`);
  }
});

test("patchIndexFile: a malformed line costs its own size, not the file", () => {
  const body = `${LINE}\n{not json\n${LINE.replace("2026-W02", "2026-W03")}\n`;
  const sizes = new Map([["2026-W02#1", 4096], ["2026-W03#1", 8192]]);
  const out = patchIndexFile(body, sizes);
  assert.equal(out.filled, 2);
  assert.equal(out.skipped.length, 1);
  const lines = out.text.split("\n");
  assert.equal(lines[1], "{not json", "the bad line survives untouched");
  assert.equal(lines[3], "", "the trailing newline is preserved");
});

test("patchIndexFile: an already-complete file is byte-identical and reports no change", () => {
  const out = patchIndexFile(`${LINE}\n`, new Map());
  assert.equal(out.changed, false);
  assert.equal(out.text, `${LINE}\n`);
});

// ── End to end, over a real store ────────────────────────────────────────────

test("a .bak- copy of an index file is invisible to every reader of the index", () => {
  // backfill-archive-sizes.ts keeps the original beside the file it replaces. That is only safe
  // because nothing globs it back in: the archiver's loadIndex and the dashboard's readIndexDir
  // both take *.jsonl, and ".jsonl.bak-<stamp>" does not end in .jsonl.
  const logdir = mkdtempSync(join(tmpdir(), "gf-bak-"));
  const dir = join(logdir, "_index", "api_logs");
  mkdirSync(dir, { recursive: true });
  const stale = JSON.stringify({ ...JSON.parse(LINE), label: "2026-W99", state: "archived" });
  writeFileSync(join(dir, "api_logs-2026.jsonl"), `${LINE}\n`);
  writeFileSync(join(dir, "api_logs-2026.jsonl.bak-2026-09-10T09-25-59-051Z"), `${stale}\n`);

  const weeks = readArchiveIndexDir(logdir, ["api_logs"]);
  assert.deepEqual(weeks.map((w) => w.week), ["2026-W02"], "the .bak- copy must not be read back in");
});

test("listSizes + patch: sizes taken from the objects the store actually holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "gf-sizes-"));
  const store = new LocalStore(root);
  mkdirSync(join(root, "archive", "api_logs", "2026"), { recursive: true });
  mkdirSync(join(root, "archive", "api_logs", "_index"), { recursive: true });
  writeFileSync(join(root, "archive/api_logs/2026/boost-api_logs-2026-W02-p001.ndjson.age"), "x".repeat(4096));
  writeFileSync(join(root, "archive/api_logs/2026/boost-api_logs-2026-W02-p001.manifest.json"), "{}");
  writeFileSync(join(root, "archive/api_logs/_index/api_logs-2026.jsonl"), `${LINE}\n`);

  const sizes = sizeIndexFrom(await store.listSizes("archive/api_logs"));
  assert.deepEqual([...sizes], [["2026-W02#1", 4096]], "the manifest is not mistaken for the archive");

  const patched = patchIndexFile((await store.cat("archive/api_logs/_index/api_logs-2026.jsonl"))!, sizes);
  assert.equal(patched.filled, 1);
  assert.equal(scrubArchiveWeek("api_logs", JSON.parse(patched.text.trim()))!.bytes, 4096);
});
