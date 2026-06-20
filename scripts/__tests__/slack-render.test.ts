import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderDailyText, dailyLabel, dashboardLink, type DailyState } from "../lib/slack.js";
import type { RunOrigin } from "../lib/backupTypes.js";

// Parity fixtures captured from the original bash _slack_daily_text (lib/slack.sh) — see
// fixtures/render-cases.json. States are PAST-dated so every 2-hourly bucket is "due"
// (date < today), making the bash output clock-independent and safe to freeze.
const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "fixtures/render-cases.json"), "utf8")) as {
  name: string;
  displayTz: string;
  state: DailyState;
  expected: string;
}[];

for (const c of cases) {
  test(`slack render parity vs bash: ${c.name}`, () => {
    const out = renderDailyText(c.state, new Date(Date.UTC(2026, 0, 1, 12, 0, 0)));
    assert.equal(out, c.expected);
  });
}

test("dailyLabel renders HH:MM in DISPLAY_TZ (UTC)", () => {
  assert.equal(dailyLabel(new Date(Date.UTC(2026, 5, 19, 16, 5, 0))), "16:05");
  assert.equal(dailyLabel(new Date(Date.UTC(2026, 5, 19, 0, 0, 0))), "00:00");
  assert.equal(dailyLabel(new Date(Date.UTC(2026, 5, 19, 9, 0, 0))), "09:00"); // base-10, not octal
});

test("renderDailyText today: +1h grace gates which empty buckets show ⬜", () => {
  // now = 05:30 UTC, today. Due buckets need 2*s+1 <= 5 → s ∈ {0,1,2} (01,03,05 ≤ 5; s=3 → 07 > 5).
  const now = new Date(Date.UTC(2026, 5, 19, 5, 30, 0));
  const state: DailyState = { channel: "", ts: "T", date: "2026-06-19", header: "*H*", entries: [] };
  assert.equal(renderDailyText(state, now), "*H*\n⬜ 00:00  ·  ⬜ 02:00  ·  ⬜ 04:00");
});

test("dashboardLink wraps text in a Slack link only when DASHBOARD_URL is set", () => {
  const saved = process.env.DASHBOARD_URL;
  try {
    delete process.env.DASHBOARD_URL;
    assert.equal(dashboardLink("boost DB backup"), "boost DB backup");
    process.env.DASHBOARD_URL = "https://dash.example.com/";
    assert.equal(dashboardLink("boost DB backup"), "<https://dash.example.com/|boost DB backup>");
  } finally {
    if (saved === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = saved;
  }
});

test("renderDailyText today: a filled bucket suppresses its ⬜", () => {
  const now = new Date(Date.UTC(2026, 5, 19, 5, 30, 0));
  const state: DailyState = {
    channel: "",
    ts: "T",
    date: "2026-06-19",
    header: "*H*",
    entries: [{ label: "02:00", ok: true, marker: "", manual: false }],
  };
  // bucket 1 (02:00) is filled → only 00:00 and 04:00 remain as due-empty placeholders.
  assert.equal(renderDailyText(state, now), "*H*\n⬜ 00:00  ·  ✅ 02:00  ·  ⬜ 04:00");
});

test("renderDailyText: origin drives the marker", () => {
  const base = { channel: "", ts: "T", date: "2026-06-19", header: "*H*" };
  const at = (o: RunOrigin): string =>
    renderDailyText(
      { ...base, entries: [{ label: "02:00", ok: true, marker: "", origin: o }] },
      new Date(Date.UTC(2026, 5, 19, 5, 30, 0)),
    );
  assert.match(at("schedule"), /· {2}✅ 02:00/);
  assert.match(at("manual"), /· {2}🖐️ ✅ 02:00/);
  assert.match(at("self-heal"), /· {2}🩹 ✅ 02:00/);
});

test("renderDailyText: legacy manual:true (no origin) still renders 🖐️", () => {
  const s: DailyState = {
    channel: "",
    ts: "T",
    date: "2026-06-19",
    header: "*H*",
    entries: [{ label: "02:00", ok: true, marker: "", manual: true }],
  };
  assert.match(renderDailyText(s, new Date(Date.UTC(2026, 5, 19, 5, 30, 0))), /🖐️ ✅ 02:00/);
});
