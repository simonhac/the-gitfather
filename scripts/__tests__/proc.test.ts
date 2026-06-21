import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runToFile, pipeToFile, capture, captureStderr, sha256File, commandExists } from "../lib/proc.js";

const scratch = mkdtempSync(join(tmpdir(), "proc-test-"));

test("runToFile: streams stdout to the file and resolves 0", async () => {
  const out = join(scratch, "a.txt");
  const code = await runToFile("printf", ["hello-world"], out);
  assert.equal(code, 0);
  assert.equal(readFileSync(out, "utf8"), "hello-world");
});

test("runToFile: a missing command resolves 127 (never rejects → fail() can run)", async () => {
  const code = await runToFile("definitely-not-a-real-binary-xyz", [], join(scratch, "b.txt"));
  assert.equal(code, 127);
});

test("pipeToFile: pipes a→b to the file and resolves 0", async () => {
  const out = join(scratch, "c.txt");
  const code = await pipeToFile({ cmd: "printf", args: ["piped"] }, { cmd: "cat", args: [] }, out);
  assert.equal(code, 0);
  assert.equal(readFileSync(out, "utf8"), "piped");
});

test("pipeToFile: pipefail — a non-zero LEFT wins even though right (cat) exits 0", async () => {
  const code = await pipeToFile({ cmd: "sh", args: ["-c", "exit 3"] }, { cmd: "cat", args: [] }, join(scratch, "d.txt"));
  assert.equal(code, 3);
});

test("pipeToFile: a missing LEFT command resolves 127 and does not hang", async () => {
  const code = await pipeToFile(
    { cmd: "definitely-not-a-real-binary-xyz", args: [] },
    { cmd: "cat", args: [] },
    join(scratch, "e.txt"),
  );
  assert.equal(code, 127);
});

test("run: resolves the child's exit code; 127 on a missing command", async () => {
  assert.equal(await run("sh", ["-c", "exit 0"], { stdio: "ignore" }), 0);
  assert.equal(await run("sh", ["-c", "exit 7"], { stdio: "ignore" }), 7);
  assert.equal(await run("definitely-not-a-real-binary-xyz", [], { stdio: "ignore" }), 127);
});

test("capture: returns ok+stdout on success, ok:false on a non-zero exit", () => {
  const okr = capture("printf", ["captured"]);
  assert.equal(okr.ok, true);
  assert.equal(okr.out, "captured");
  const bad = capture("sh", ["-c", "exit 1"]);
  assert.equal(bad.ok, false);
});

test("commandExists: true for sh, false for a bogus binary", () => {
  assert.equal(commandExists("sh"), true);
  assert.equal(commandExists("definitely-not-a-real-binary-xyz"), false);
});

test("sha256File: streams the same digest as a one-shot hash", async () => {
  const p = join(scratch, "h.bin");
  const data = "the-gitfather\n".repeat(5000);
  writeFileSync(p, data);
  const expected = createHash("sha256").update(data).digest("hex");
  assert.equal(await sha256File(p), expected);
});

test("captureStderr: captures stderr + the exit code; stdout is not captured", async () => {
  const r = await captureStderr("sh", ["-c", "echo oops 1>&2; echo out; exit 4"]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /oops/);
  assert.ok(!r.stderr.includes("out"));
});

test("captureStderr: a missing command resolves 127 (never rejects)", async () => {
  const r = await captureStderr("definitely-not-a-real-binary-xyz", []);
  assert.equal(r.code, 127);
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
