import { test } from "node:test";
import assert from "node:assert/strict";
import { dueCadences } from "../../scheduler/src/cadences.js";
import { isWeekEligible, parseWeekLabel } from "../lib/archive.js";

const archiveDue = (iso: string) => dueCadences(new Date(iso)).includes("archive");

test("archive is due Monday 00:30 UTC and at no other tick", () => {
  assert.equal(archiveDue("2026-10-05T00:30:00Z"), true);
  assert.equal(archiveDue("2026-10-05T00:00:00Z"), false); // the week boundary itself, a backup instant
  assert.equal(archiveDue("2026-10-04T19:30:00Z"), false); // the old Sunday slot
  assert.equal(archiveDue("2026-10-06T00:30:00Z"), false); // Tuesday
});

test("the archive tick lands just after the UTC week boundary, so a week is never a run late", () => {
  // 2026-W27 ends Mon 6 Jul 00:00Z; with a 13-week horizon it becomes eligible Mon 5 Oct 00:00Z.
  // The 00:30 run that morning must see it — the old Sunday 19:30 slot missed by 4.5h.
  const w27 = parseWeekLabel("2026-W27");
  assert.equal(isWeekEligible(w27, new Date("2026-10-05T00:30:00Z"), 13), true);
  assert.equal(isWeekEligible(w27, new Date("2026-10-04T19:30:00Z"), 13), false);
});
