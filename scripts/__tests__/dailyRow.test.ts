import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  dailyHeaderIn,
  dailyLabelIn,
  dailyStateKey,
  dateKeyIn,
  failAlertTextIn,
  link,
  parseDailyState,
  renderDailyTextIn,
  tzPartsIn,
  type DailyState,
  type RowContext,
} from "../lib/dailyRow.js";
import type { RunOrigin } from "../lib/runOrigin.js";

// The parameterised renderer the Cloudflare Worker bundles — the row's only renderer now that the
// Worker is its only writer. Pinned with explicit zones and cadences, because the Worker has no
// DISPLAY_TZ / SLOT_MINUTES constants to lean on.

const perth: RowContext = { tz: "Australia/Perth", slotMinutes: 480, name: "beta", dashboardUrl: "" };
/** The engine's defaults: UTC, 3 a day. */
const utc: RowContext = { tz: "UTC", slotMinutes: 480, name: "beta", dashboardUrl: "" };

// Golden fixtures — see fixtures/render-cases.json (once the parity cases against the old bash
// renderer). States are PAST-dated so every slot is "due" (date < today), making the output
// clock-independent and safe to freeze.
const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "fixtures/render-cases.json"), "utf8")) as {
  name: string;
  displayTz: string;
  state: DailyState;
  expected: string;
}[];

for (const c of cases) {
  test(`renderDailyTextIn golden: ${c.name}`, () => {
    const out = renderDailyTextIn(c.state, new Date(Date.UTC(2026, 0, 1, 12, 0, 0)), { ...utc, tz: c.displayTz });
    assert.equal(out, c.expected);
  });
}

test("tzPartsIn / dateKeyIn / dailyLabelIn: calendar parts in the given zone, not the process zone", () => {
  const d = new Date(Date.UTC(2026, 8, 9, 23, 30, 0)); // 23:30 UTC Wed 9 Sep = 07:30 Thu 10 Sep in Perth (+8)
  assert.deepEqual(tzPartsIn(d, "Australia/Perth"), { y: 2026, mo: 9, day: 10, hour: 7 });
  assert.deepEqual(tzPartsIn(d, "UTC"), { y: 2026, mo: 9, day: 9, hour: 23 });
  assert.equal(dateKeyIn(d, "Australia/Perth"), "2026-09-10");
  assert.equal(dailyLabelIn(d, "Australia/Perth"), "07:30");
  assert.equal(dailyLabelIn(new Date(Date.UTC(2026, 8, 9, 16, 5, 0)), "Australia/Perth"), "00:05"); // midnight wraps to 00, not 24
  assert.equal(dailyStateKey("beta", "2026-09-10"), "_status/beta/2026-09-10.json");
});

test("dailyHeaderIn: weekday/day/month/year in the zone, with the zone's abbreviation; dashboard link optional", () => {
  const d = new Date(Date.UTC(2026, 8, 9, 23, 30, 0));
  assert.equal(dailyHeaderIn(d, perth), "*beta DB backup — Thu 10 Sep 2026 (AWST)*");
  assert.equal(dailyHeaderIn(d, { ...perth, dashboardUrl: "https://dash.example.com/" }), "*<https://dash.example.com/|beta DB backup> — Thu 10 Sep 2026 (AWST)*");
});

test("renderDailyTextIn: ⬜ for wholly-elapsed empty slots at the given cadence, in the given zone", () => {
  // 8-hourly in Perth: slots 00/08/16. At 17:00 Perth (09:00 UTC) the 00 and 08 slots have wholly elapsed.
  const now = new Date(Date.UTC(2026, 8, 10, 9, 0, 0));
  const state: DailyState = {
    channel: "C1",
    ts: "1.2",
    date: "2026-09-10",
    header: "*beta DB backup — Thu 10 Sep 2026 (AWST)*",
    entries: [{ label: "08:03", ok: true, marker: "", origin: "self-heal" }],
  };
  assert.equal(renderDailyTextIn(state, now, perth), "*beta DB backup — Thu 10 Sep 2026 (AWST)*\n⬜ 00:00  ·  🩹 ✅ 08:03");
  // A finer cadence yields more placeholders for the same instant.
  const hourly = renderDailyTextIn(state, now, { ...perth, slotMinutes: 120 });
  assert.equal(hourly.split("⬜").length - 1, 7); // 00,02,04,06 + 10,12,14 elapsed and empty; 08 filled; 16 mid-slot
  // Today at 17:00 with 12-hour slots: only the 00 slot has wholly elapsed; the 12 slot is mid-flight.
  assert.equal(renderDailyTextIn({ ...state, entries: [] }, now, { ...perth, slotMinutes: 720 }).split("\n")[1], "⬜ 00:00");
  // A past day: every empty slot is due.
  assert.equal(renderDailyTextIn({ ...state, date: "2026-09-09", entries: [] }, now, { ...perth, slotMinutes: 720 }).split("\n")[1], "⬜ 00:00  ·  ⬜ 12:00");
});

test("failAlertTextIn: mention-free, dashboard-linked title, plain reason when there is no job log", () => {
  assert.equal(failAlertTextIn("STALE", "slot overdue", "", perth), "🔴 *beta DB backup* STALE — slot overdue");
  assert.equal(
    failAlertTextIn("STALE", "slot overdue", "https://gh/log", { ...perth, dashboardUrl: "https://d/" }),
    "🔴 *<https://d/|beta DB backup>* STALE — <https://gh/log|slot overdue>",
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

test("dailyLabelIn: HH:MM, zero-padded base-10 (UTC)", () => {
  assert.equal(dailyLabelIn(new Date(Date.UTC(2026, 5, 19, 16, 5, 0)), "UTC"), "16:05");
  assert.equal(dailyLabelIn(new Date(Date.UTC(2026, 5, 19, 0, 0, 0)), "UTC"), "00:00");
  assert.equal(dailyLabelIn(new Date(Date.UTC(2026, 5, 19, 9, 0, 0)), "UTC"), "09:00"); // base-10, not octal
});

test("renderDailyTextIn today: only WHOLLY-elapsed slots show ⬜", () => {
  // now = 16:30 UTC, today. A slot is due once it has fully elapsed: 8*(s+1) <= 16 → s ∈ {0,1}
  // (slots 0 [00:00) and 1 [08:00) closed; slot 2 [16:00) still open → no premature ⬜).
  const now = new Date(Date.UTC(2026, 5, 19, 16, 30, 0));
  const state: DailyState = { channel: "", ts: "T", date: "2026-06-19", header: "*H*", entries: [] };
  assert.equal(renderDailyTextIn(state, now, utc), "*H*\n⬜ 00:00  ·  ⬜ 08:00");
});

test("renderDailyTextIn today: a filled slot suppresses its ⬜", () => {
  const now = new Date(Date.UTC(2026, 5, 19, 16, 30, 0));
  const state: DailyState = {
    channel: "",
    ts: "T",
    date: "2026-06-19",
    header: "*H*",
    entries: [{ label: "08:00", ok: true, marker: "", manual: false }],
  };
  // slot 1 (floor(8/8)=1) is filled → of the wholly-elapsed slots {0,1}, only slot 0 (00:00) is a
  // due-empty placeholder; slot 2 [16:00) is still open so it shows nothing.
  assert.equal(renderDailyTextIn(state, now, utc), "*H*\n⬜ 00:00  ·  ✅ 08:00");
});

test("renderDailyTextIn: origin drives the marker", () => {
  const base = { channel: "", ts: "T", date: "2026-06-19", header: "*H*" };
  // Entry in slot 1 (10:00), now 16:30 → slot 0 (00:00) is a due-empty ⬜ that precedes the tick.
  const at = (o: RunOrigin): string =>
    renderDailyTextIn(
      { ...base, entries: [{ label: "10:00", ok: true, marker: "", origin: o }] },
      new Date(Date.UTC(2026, 5, 19, 16, 30, 0)),
      utc,
    );
  assert.match(at("schedule"), /· {2}✅ 10:00/);
  assert.match(at("manual"), /· {2}🖐️ ✅ 10:00/);
  assert.match(at("self-heal"), /· {2}🩹 ✅ 10:00/);
});

test("renderDailyTextIn: legacy manual:true (no origin) still renders 🖐️", () => {
  const s: DailyState = {
    channel: "",
    ts: "T",
    date: "2026-06-19",
    header: "*H*",
    entries: [{ label: "02:00", ok: true, marker: "", manual: true }],
  };
  assert.match(renderDailyTextIn(s, new Date(Date.UTC(2026, 5, 19, 5, 30, 0)), utc), /🖐️ ✅ 02:00/);
});

test("dailyHeaderIn: the dashboard link comes from the context, so adding a url relinks the day's header", () => {
  const now = new Date(Date.UTC(2026, 5, 22, 5, 30, 0));
  // First created before dashboard.url existed → plain header.
  const plain = dailyHeaderIn(now, utc);
  assert.equal(plain, "*beta DB backup — Mon 22 Jun 2026 (UTC)*");
  // url now configured → the same day's header recomputes WITH the link.
  assert.equal(
    dailyHeaderIn(now, { ...utc, dashboardUrl: "https://dash.example.com/" }),
    "*<https://dash.example.com/|beta DB backup> — Mon 22 Jun 2026 (UTC)*",
  );
});

test("dailyHeaderIn: full date + timezone tail in a non-UTC zone, following its DST", () => {
  const sydney: RowContext = { tz: "Australia/Sydney", slotMinutes: 480, name: "alpha", dashboardUrl: "" };
  // 04:00 UTC on 18 Aug 2026 = 14:00 Tue 18 Aug in Sydney, in AEST (not AEDT).
  assert.equal(dailyHeaderIn(new Date("2026-08-18T04:00:00Z"), sydney), "*alpha DB backup — Tue 18 Aug 2026 (AEST)*");
  // Southern DST: same zone, January → AEDT, and the date rolls to the 19th (15:00 local).
  assert.equal(dailyHeaderIn(new Date("2026-01-19T04:00:00Z"), sydney), "*alpha DB backup — Mon 19 Jan 2026 (AEDT)*");
});

test("link wraps text in a Slack mrkdwn link only when a url is given", () => {
  assert.equal(link("", "pg_dump failed"), "pg_dump failed");
  assert.equal(link("https://x/", "pg_dump failed"), "<https://x/|pg_dump failed>");
});

test("failAlertTextIn: the title links to the dashboard and the reason to the job log", () => {
  assert.equal(
    failAlertTextIn("FAILED at 07:46", "pg_dump failed", "https://github.com/o/r/actions/runs/1/job/2", {
      ...utc,
      dashboardUrl: "https://dash.example.com/",
    }),
    "🔴 *<https://dash.example.com/|beta DB backup>* FAILED at 07:46 — " +
      "<https://github.com/o/r/actions/runs/1/job/2|pg_dump failed>",
  );
  // `what` is the caller-supplied middle clause (sibling alerts).
  assert.equal(failAlertTextIn("durable-verify FAILED", "hash mismatch", "", utc), "🔴 *beta DB backup* durable-verify FAILED — hash mismatch");
});
