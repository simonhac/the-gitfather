import { test } from "node:test";
import assert from "node:assert/strict";
import { bindUnits, NBSP } from "../lib/units.js";
import { retentionBullets, archiveBlurb, slotCadencePhrase, DEFAULT_RETENTION } from "../lib/backupTypes.js";

// U+00A0 and U+0020 look identical in a failure message, so every assertion here is written against
// the NBSP constant rather than against a pasted character.
const bound = (n: string, unit: string): string => `${n}${NBSP}${unit}`;

test("bindUnits: a number and the word it measures cannot be split", () => {
  for (const [n, unit] of [["5.9", "MB"], ["3,045", "rows"], ["2", "weeks"], ["1", "week"],
                           ["227", "GB"], ["64", "backups"], ["10", "Sept"], ["8:00", "am"]]) {
    assert.equal(bindUnits(`${n} ${unit}`), bound(n, unit));
  }
});

test("bindUnits: every pair on a line is bound, not just the first", () => {
  assert.equal(
    bindUnits("Archived 2 weeks · 97,274 rows · 5.9 MB"),
    `Archived ${bound("2", "weeks")} · ${bound("97,274", "rows")} · ${bound("5.9", "MB")}`,
  );
});

test("bindUnits: spaces that are NOT a number meeting its unit stay breakable", () => {
  // A tooltip is ~240px wide; gluing text that has no reason to stay together only makes the panel
  // wider. A digit before a digit is a date or a separator, and a digit before punctuation is a
  // break the panel actively wants.
  for (const s of ["Sun, 24 May 2026, 7:30 pm UTC", "Archiver runs this week · 1 — Archived",
                   "Week of 18 May 26 · T1 api_logs", "rows deleted from the database"]) {
    assert.equal(bindUnits(s).includes(`26${NBSP}·`), false, s);
  }
  assert.equal(bindUnits("2026, 7:30 pm"), `2026, ${bound("7:30", "pm")}`, "the year keeps its break");
  assert.equal(bindUnits("· 1 — Archived"), "· 1 — Archived", "an em dash is a break opportunity");
});

test("bindUnits: idempotent — a panel rebuilt from bound text is unchanged", () => {
  const once = bindUnits("Archived 2 weeks · 5.9 MB");
  assert.equal(bindUnits(once), once);
});

// The reason this rule is applied to rendered text rather than to the builders: these three produce
// numbers and units, none of them knows about the others, and none of them should have to.
test("the page's prose still reads as plain strings — binding is the renderer's job", () => {
  const prose = [...retentionBullets(DEFAULT_RETENTION), slotCadencePhrase(),
                 Object.values(archiveBlurb([{ table: "api_logs", archiveAfterWeeks: 4, pruneAfterWeeks: 13 }])).join("")];
  for (const s of prose) assert.equal(s.includes(NBSP), false, `${s} should carry no U+00A0`);
  // …and the renderer's pass is what makes them safe.
  assert.equal(bindUnits(retentionBullets(DEFAULT_RETENTION)[1]).includes(bound("3", "weeks")), true);
});
