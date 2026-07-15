import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../lib/duration.js";
import { DEFAULT_RETENTION, maxRetained } from "../lib/backupTypes.js";

test("parseDuration: days/weeks/years → days + normalised label", () => {
  assert.deepEqual(parseDuration("2 days"), { days: 2, label: "2 days" });
  assert.deepEqual(parseDuration("3 weeks"), { days: 21, label: "3 weeks" });
  assert.deepEqual(parseDuration("13 weeks"), { days: 91, label: "13 weeks" });
  assert.deepEqual(parseDuration("2 years"), { days: 730, label: "2 years" });
});

test("parseDuration: months ≈ 365/12 days", () => {
  assert.equal(parseDuration("6 months").days, 6 * (365 / 12));
});

test("parseDuration: re-pluralises the label to agree with the count", () => {
  assert.equal(parseDuration("1 day").label, "1 day");
  assert.equal(parseDuration("1 week").label, "1 week");
  assert.equal(parseDuration("1 days").label, "1 day"); // singular input count → singular label
});

test("parseDuration: accepts singular or plural unit, case-insensitive, extra spaces", () => {
  assert.equal(parseDuration("  2   Weeks ").days, 14);
  assert.equal(parseDuration("1 YEAR").days, 365);
});

test("parseDuration: rejects malformed input", () => {
  for (const bad of ["", "soon", "two weeks", "2", "weeks", "2 fortnights", "-3 days", "1.5 weeks"]) {
    assert.throws(() => parseDuration(bad), /invalid duration/, `should reject "${bad}"`);
  }
});

test("maxRetained(DEFAULT_RETENTION) === 64 (6 grandson + 21 son + 13 father + 24 grandfather)", () => {
  assert.equal(maxRetained(DEFAULT_RETENTION), 64);
});
