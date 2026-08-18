import { test } from "node:test";
import assert from "node:assert/strict";
import { tzAbbrev } from "../lib/tzAbbrev.js";

// Two instants either side of the southern/northern DST split, so each zone is exercised in both
// of its offsets. tzAbbrev takes the zone explicitly, so none of this depends on DISPLAY_TZ.
const AUG = new Date("2026-08-18T04:00:00Z");
const JAN = new Date("2026-01-18T04:00:00Z");

test("tzAbbrev: Australian zones get real abbreviations, not GMT offsets", () => {
  // The reported bug: this rendered "GMT+10" when the formatter was locked to en-US.
  assert.equal(tzAbbrev(AUG, "Australia/Sydney"), "AEST");
  assert.equal(tzAbbrev(JAN, "Australia/Sydney"), "AEDT"); // DST flip
  assert.equal(tzAbbrev(AUG, "Australia/Perth"), "AWST"); // no DST
  assert.equal(tzAbbrev(AUG, "Australia/Adelaide"), "ACST"); // half-hour offset
  assert.equal(tzAbbrev(JAN, "Australia/Adelaide"), "ACDT");
  assert.equal(tzAbbrev(AUG, "Pacific/Auckland"), "NZST");
});

test("tzAbbrev: US zones still resolve — probing en-AU first must not cost en-US", () => {
  assert.equal(tzAbbrev(AUG, "America/New_York"), "EDT");
  assert.equal(tzAbbrev(JAN, "America/New_York"), "EST");
  assert.equal(tzAbbrev(AUG, "America/Los_Angeles"), "PDT");
});

test("tzAbbrev: bare GMT/UTC are real answers, not the offset fallback", () => {
  assert.equal(tzAbbrev(AUG, "UTC"), "UTC"); // what the frozen render fixtures expect
  assert.equal(tzAbbrev(AUG, "Europe/London"), "BST");
  assert.equal(tzAbbrev(JAN, "Europe/London"), "GMT"); // must not be rejected as an offset
});

test("tzAbbrev: falls back to the offset where English CLDR has no abbreviation", () => {
  assert.equal(tzAbbrev(AUG, "Asia/Tokyo"), "GMT+9");
  assert.equal(tzAbbrev(AUG, "America/Sao_Paulo"), "GMT-3");
});
