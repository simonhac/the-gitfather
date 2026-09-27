import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, tierOf } from "../drill-object.js";

// Importing this module must not DRILL anything — the script guards main() behind isEntrypoint().
// If that guard is ever dropped, this file's mere existence would start hitting R2.

test("parseArgs: --key and the safe defaults", () => {
  const a = parseArgs(["--key", "monthly/boost-20260901T160102Z.dump.age"]);
  assert.equal(a.key, "monthly/boost-20260901T160102Z.dump.age");
  assert.equal(a.gate, "nonempty", "a durable copy is weeks old — a live ratio would be meaningless");
  assert.equal(a.record, true, "a drill that does not record is a drill nobody can see");
  assert.equal(a.list, false);
});

test("parseArgs: --gate live-ratio is accepted, anything else is rejected", () => {
  assert.equal(parseArgs(["--key", "daily/x.dump", "--gate", "live-ratio"]).gate, "live-ratio");
  assert.throws(() => parseArgs(["--gate", "sortof"]), /--gate must be nonempty or live-ratio/);
});

test("parseArgs: an unknown flag throws rather than being ignored", () => {
  // Silently ignoring a typo'd flag is how someone runs --norecord and believes they recorded.
  assert.throws(() => parseArgs(["--norecord"]), /unknown argument --norecord/);
});

test("parseArgs: --list and --no-record", () => {
  assert.equal(parseArgs(["--list"]).list, true);
  assert.equal(parseArgs(["--key", "daily/x.dump", "--no-record"]).record, false);
});

test("tierOf: reads the tier from the key, and answers null rather than guessing", () => {
  assert.equal(tierOf("monthly/boost-20260901T160102Z.dump.age"), "monthly");
  assert.equal(tierOf("2hourly/boost-20260925T160306Z.dump.age"), "2hourly");
  assert.equal(tierOf("boost-20260925T160306Z.dump.age"), null, "no tier prefix");
  assert.equal(tierOf("quarterly/x.dump"), null, "not one of ours");
});
