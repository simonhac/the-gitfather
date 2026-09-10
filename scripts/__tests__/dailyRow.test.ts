import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyHeaderIn, dailyLabelIn, dailyStateKey, dateKeyIn, failAlertTextIn, parseDailyState, renderDailyTextIn, tzPartsIn, type DailyState, type RowContext } from "../lib/dailyRow.js";

// The parameterised renderer the Cloudflare Worker bundles. slack-render.test.ts pins the Actions-side
// wrapper (UTC, profile-bound); this pins the same functions with an explicit non-UTC zone and cadence,
// because the Worker has no DISPLAY_TZ / SLOT_MINUTES constants to lean on.

const perth: RowContext = { tz: "Australia/Perth", slotMinutes: 480, name: "boost", dashboardUrl: "" };

test("tzPartsIn / dateKeyIn / dailyLabelIn: calendar parts in the given zone, not the process zone", () => {
  const d = new Date(Date.UTC(2026, 8, 9, 23, 30, 0)); // 23:30 UTC Wed 9 Sep = 07:30 Thu 10 Sep in Perth (+8)
  assert.deepEqual(tzPartsIn(d, "Australia/Perth"), { y: 2026, mo: 9, day: 10, hour: 7 });
  assert.deepEqual(tzPartsIn(d, "UTC"), { y: 2026, mo: 9, day: 9, hour: 23 });
  assert.equal(dateKeyIn(d, "Australia/Perth"), "2026-09-10");
  assert.equal(dailyLabelIn(d, "Australia/Perth"), "07:30");
  assert.equal(dailyLabelIn(new Date(Date.UTC(2026, 8, 9, 16, 5, 0)), "Australia/Perth"), "00:05"); // midnight wraps to 00, not 24
  assert.equal(dailyStateKey("boost", "2026-09-10"), "_status/boost/2026-09-10.json");
});

test("dailyHeaderIn: weekday/day/month/year in the zone, with the zone's abbreviation; dashboard link optional", () => {
  const d = new Date(Date.UTC(2026, 8, 9, 23, 30, 0));
  assert.equal(dailyHeaderIn(d, perth), "*boost DB backup — Thu 10 Sep 2026 (AWST)*");
  assert.equal(dailyHeaderIn(d, { ...perth, dashboardUrl: "https://dash.example.com/" }), "*<https://dash.example.com/|boost DB backup> — Thu 10 Sep 2026 (AWST)*");
});

test("renderDailyTextIn: ⬜ for wholly-elapsed empty slots at the given cadence, in the given zone", () => {
  // 8-hourly in Perth: slots 00/08/16. At 17:00 Perth (09:00 UTC) the 00 and 08 slots have wholly elapsed.
  const now = new Date(Date.UTC(2026, 8, 10, 9, 0, 0));
  const state: DailyState = {
    channel: "C1",
    ts: "1.2",
    date: "2026-09-10",
    header: "*boost DB backup — Thu 10 Sep 2026 (AWST)*",
    entries: [{ label: "08:03", ok: true, marker: "", origin: "self-heal" }],
  };
  assert.equal(renderDailyTextIn(state, now, perth), "*boost DB backup — Thu 10 Sep 2026 (AWST)*\n⬜ 00:00  ·  🩹 ✅ 08:03");
  // A finer cadence yields more placeholders for the same instant.
  const hourly = renderDailyTextIn(state, now, { ...perth, slotMinutes: 120 });
  assert.equal(hourly.split("⬜").length - 1, 7); // 00,02,04,06 + 10,12,14 elapsed and empty; 08 filled; 16 mid-slot
  // Today at 17:00 with 12-hour slots: only the 00 slot has wholly elapsed; the 12 slot is mid-flight.
  assert.equal(renderDailyTextIn({ ...state, entries: [] }, now, { ...perth, slotMinutes: 720 }).split("\n")[1], "⬜ 00:00");
  // A past day: every empty slot is due.
  assert.equal(renderDailyTextIn({ ...state, date: "2026-09-09", entries: [] }, now, { ...perth, slotMinutes: 720 }).split("\n")[1], "⬜ 00:00  ·  ⬜ 12:00");
});

test("failAlertTextIn: mention-free, dashboard-linked title, plain reason when there is no job log", () => {
  assert.equal(failAlertTextIn("STALE", "slot overdue", "", perth), "🔴 *boost DB backup* STALE — slot overdue");
  assert.equal(
    failAlertTextIn("STALE", "slot overdue", "https://gh/log", { ...perth, dashboardUrl: "https://d/" }),
    "🔴 *<https://d/|boost DB backup>* STALE — <https://gh/log|slot overdue>",
  );
});

test("parseDailyState: malformed state → null (skip the refresh), legacy shapes tolerated", () => {
  assert.equal(parseDailyState(""), null);
  assert.equal(parseDailyState("{"), null);
  assert.equal(parseDailyState('{"date":"2026-09-10"}'), null); // no entries
  const legacy = parseDailyState('{"date":"2026-09-10","entries":[{"label":"08:03","ok":true,"marker":"","manual":true}]}');
  assert.ok(legacy);
  assert.equal(legacy.ts, "");
  assert.equal(legacy.entries[0].manual, true);
});
