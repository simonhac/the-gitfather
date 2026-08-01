import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore, SuppressedStore, ObjectExistsError, parseTarget } from "../lib/store.js";

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gf-store-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── Target parsing ───────────────────────────────────────────────────────────

test("parseTarget: r2 is the default, local:<dir> selects the filesystem sink", () => {
  assert.deepEqual(parseTarget(undefined), { kind: "r2" });
  assert.deepEqual(parseTarget("r2"), { kind: "r2" });
  assert.deepEqual(parseTarget("local:/tmp/archive"), { kind: "local", dir: "/tmp/archive" });
  assert.deepEqual(parseTarget("local:./rel"), { kind: "local", dir: "./rel" });
});

test("parseTarget: rejects anything else rather than silently defaulting to R2", () => {
  for (const bad of ["", "local", "local:", "s3://bucket", "file:/tmp"]) {
    assert.throws(() => parseTarget(bad), /invalid --target/, `should reject "${bad}"`);
  }
});

// ── LocalStore ───────────────────────────────────────────────────────────────

test("LocalStore: put → exists → cat round-trips, creating nested directories", async () => {
  const { dir, cleanup } = scratch();
  try {
    const store = new LocalStore(dir);
    const src = join(dir, "src.bin");
    writeFileSync(src, "hello archive");

    assert.equal(await store.exists("a/b/c/thing.ndjson"), false);
    await store.put(src, "a/b/c/thing.ndjson");
    assert.equal(await store.exists("a/b/c/thing.ndjson"), true);
    assert.equal(await store.cat("a/b/c/thing.ndjson"), "hello archive");
    assert.equal(readFileSync(join(dir, "a/b/c/thing.ndjson"), "utf8"), "hello archive");
  } finally {
    cleanup();
  }
});

test("LocalStore: cat of a missing key is null, not a throw", async () => {
  const { dir, cleanup } = scratch();
  try {
    assert.equal(await new LocalStore(dir).cat("nope.json"), null);
  } finally {
    cleanup();
  }
});

test("LocalStore: put REFUSES to overwrite — the local target emulates WORM too", async () => {
  // The R2 side is protected by a no-delete token plus unique keys; the local sink has no such
  // backstop, so it has to refuse in code or local testing would quietly diverge from production.
  const { dir, cleanup } = scratch();
  try {
    const store = new LocalStore(dir);
    const src = join(dir, "src.bin");
    writeFileSync(src, "first");
    await store.put(src, "w/thing.ndjson");

    writeFileSync(src, "second");
    await assert.rejects(() => store.put(src, "w/thing.ndjson"), ObjectExistsError);
    assert.equal(await store.cat("w/thing.ndjson"), "first", "the original bytes must survive");
  } finally {
    cleanup();
  }
});

test("LocalStore: putText refuses to overwrite, putTextOverwrite is the explicit exception", async () => {
  const { dir, cleanup } = scratch();
  try {
    const store = new LocalStore(dir);
    await store.putText("v1", "x/_index/i.jsonl");
    await assert.rejects(() => store.putText("v2", "x/_index/i.jsonl"), ObjectExistsError);
    // The derived index is a materialised view, rewritten every run — the one key that may move.
    await store.putTextOverwrite("v2", "x/_index/i.jsonl");
    assert.equal(await store.cat("x/_index/i.jsonl"), "v2");
  } finally {
    cleanup();
  }
});

test("LocalStore: list returns store-relative keys under a prefix, recursively", async () => {
  const { dir, cleanup } = scratch();
  try {
    const store = new LocalStore(dir);
    await store.putText("a", "arch/api_logs/2026/one.manifest.json");
    await store.putText("b", "arch/api_logs/2026/two.manifest.json");
    await store.putText("c", "arch/api_logs/2027/three.manifest.json");
    await store.putText("d", "other/nope.json");

    assert.deepEqual((await store.list("arch/api_logs")).sort(), [
      "arch/api_logs/2026/one.manifest.json",
      "arch/api_logs/2026/two.manifest.json",
      "arch/api_logs/2027/three.manifest.json",
    ]);
    assert.deepEqual(await store.list("arch/api_logs/2027"), ["arch/api_logs/2027/three.manifest.json"]);
  } finally {
    cleanup();
  }
});

test("LocalStore: list of a missing prefix is empty, not a throw", async () => {
  const { dir, cleanup } = scratch();
  try {
    assert.deepEqual(await new LocalStore(dir).list("never/created"), []);
  } finally {
    cleanup();
  }
});

test("LocalStore: fetchToFile copies an object back out for verification", async () => {
  const { dir, cleanup } = scratch();
  try {
    const store = new LocalStore(dir);
    await store.putText("payload", "k/obj.bin");
    const out = join(dir, "roundtrip.bin");
    await store.fetchToFile("k/obj.bin", out);
    assert.equal(readFileSync(out, "utf8"), "payload");
  } finally {
    cleanup();
  }
});

// ── SuppressedStore (--dry-run=store) ────────────────────────────────────────

test("SuppressedStore: writes are recorded but never reach the underlying store", async () => {
  const { dir, cleanup } = scratch();
  try {
    const inner = new LocalStore(dir);
    const store = new SuppressedStore(inner);
    const src = join(dir, "src.bin");
    writeFileSync(src, "bytes");

    await store.put(src, "a/one.ndjson.age");
    await store.putText("{}", "a/one.manifest.json");
    await store.putTextOverwrite("{}", "a/_index/i.jsonl");

    assert.deepEqual(store.suppressed, ["a/one.ndjson.age", "a/one.manifest.json", "a/_index/i.jsonl"]);
    assert.equal(existsSync(join(dir, "a/one.ndjson.age")), false, "nothing may hit the disk");
    assert.equal(await inner.exists("a/one.manifest.json"), false);
  } finally {
    cleanup();
  }
});

test("SuppressedStore: reads still pass through — planning must see real prior state", async () => {
  const { dir, cleanup } = scratch();
  try {
    const inner = new LocalStore(dir);
    await inner.putText("real", "already/there.json");
    const store = new SuppressedStore(inner);

    assert.equal(await store.exists("already/there.json"), true);
    assert.equal(await store.cat("already/there.json"), "real");
    assert.deepEqual(await store.list("already"), ["already/there.json"]);
  } finally {
    cleanup();
  }
});

test("SuppressedStore: a suppressed write reads back as ABSENT, not as present", async () => {
  // Otherwise a dry run would plan part 2 for a week it only pretended to write in part 1.
  const { dir, cleanup } = scratch();
  try {
    const store = new SuppressedStore(new LocalStore(dir));
    await store.putText("{}", "a/one.manifest.json");
    assert.equal(await store.exists("a/one.manifest.json"), false);
  } finally {
    cleanup();
  }
});
