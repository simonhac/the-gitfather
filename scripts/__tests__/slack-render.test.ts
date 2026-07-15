import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderDailyText, dailyLabel, dashboardLink, dailyHeader, link, failAlertText, type DailyState } from "../lib/slack.js";
import { githubRunInfo } from "../lib/github.js";
import { setProfileForTest, profileSchema } from "../lib/config.js";
import type { RunOrigin } from "../lib/backupTypes.js";

// Golden fixtures for renderDailyText — see fixtures/render-cases.json. States are PAST-dated so
// every slot is "due" (date < today), making the output clock-independent and safe to freeze.
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

test("renderDailyText today: only WHOLLY-elapsed slots show ⬜", () => {
  // now = 16:30 UTC, today. A slot is due once it has fully elapsed: 8*(s+1) <= 16 → s ∈ {0,1}
  // (slots 0 [00:00) and 1 [08:00) closed; slot 2 [16:00) still open → no premature ⬜).
  const now = new Date(Date.UTC(2026, 5, 19, 16, 30, 0));
  const state: DailyState = { channel: "", ts: "T", date: "2026-06-19", header: "*H*", entries: [] };
  assert.equal(renderDailyText(state, now), "*H*\n⬜ 00:00  ·  ⬜ 08:00");
});

test("dashboardLink wraps text in a Slack link only when the dashboard url is set", () => {
  try {
    setProfileForTest(profileSchema.parse({ name: "boost" }));
    assert.equal(dashboardLink("boost DB backup"), "boost DB backup");
    setProfileForTest(profileSchema.parse({ name: "boost", dashboard: { url: "https://dash.example.com/" } }));
    assert.equal(dashboardLink("boost DB backup"), "<https://dash.example.com/|boost DB backup>");
  } finally {
    setProfileForTest(null); // don't leak the injected profile into sibling tests
  }
});

test("dailyHeader recomputes the link from current config — relinks a frozen plain header", () => {
  try {
    const now = new Date(Date.UTC(2026, 5, 22, 5, 30, 0));
    // First created before dashboard.url existed → plain header (this is what gets frozen into state).
    setProfileForTest(profileSchema.parse({ name: "boost" }));
    const plain = dailyHeader(now);
    assert.ok(plain.startsWith("*boost DB backup — "), `unexpected plain header: ${plain}`);
    assert.ok(!plain.includes("<https"), "plain header must not contain a link");
    // url now configured → the same day's header recomputes WITH the link, so persistDaily relinks in place.
    setProfileForTest(profileSchema.parse({ name: "boost", dashboard: { url: "https://dash.example.com/" } }));
    const linked = dailyHeader(now);
    assert.ok(
      linked.startsWith("*<https://dash.example.com/|boost DB backup> — "),
      `header should be relinked: ${linked}`,
    );
  } finally {
    setProfileForTest(null); // don't leak the injected profile into sibling tests
  }
});

test("renderDailyText today: a filled slot suppresses its ⬜", () => {
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
  assert.equal(renderDailyText(state, now), "*H*\n⬜ 00:00  ·  ✅ 08:00");
});

test("renderDailyText: origin drives the marker", () => {
  const base = { channel: "", ts: "T", date: "2026-06-19", header: "*H*" };
  // Entry in slot 1 (10:00), now 16:30 → slot 0 (00:00) is a due-empty ⬜ that precedes the tick.
  const at = (o: RunOrigin): string =>
    renderDailyText(
      { ...base, entries: [{ label: "10:00", ok: true, marker: "", origin: o }] },
      new Date(Date.UTC(2026, 5, 19, 16, 30, 0)),
    );
  assert.match(at("schedule"), /· {2}✅ 10:00/);
  assert.match(at("manual"), /· {2}🖐️ ✅ 10:00/);
  assert.match(at("self-heal"), /· {2}🩹 ✅ 10:00/);
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

test("link wraps text in a Slack mrkdwn link only when a url is given", () => {
  assert.equal(link("", "pg_dump failed"), "pg_dump failed");
  assert.equal(link("https://x/", "pg_dump failed"), "<https://x/|pg_dump failed>");
});

test("failAlertText degrades to plain text with no dashboard url and no log url", () => {
  try {
    setProfileForTest(profileSchema.parse({ name: "boost" }));
    assert.equal(
      failAlertText("FAILED at 07:46", "pg_dump failed"),
      "🔴 *boost DB backup* FAILED at 07:46 — pg_dump failed",
    );
  } finally {
    setProfileForTest(null);
  }
});

test("failAlertText links the title to the dashboard and the reason to the job log", () => {
  try {
    setProfileForTest(profileSchema.parse({ name: "boost", dashboard: { url: "https://dash.example.com/" } }));
    assert.equal(
      failAlertText("FAILED at 07:46", "pg_dump failed", "https://github.com/o/r/actions/runs/1/job/2"),
      "🔴 *<https://dash.example.com/|boost DB backup>* FAILED at 07:46 — " +
        "<https://github.com/o/r/actions/runs/1/job/2|pg_dump failed>",
    );
  } finally {
    setProfileForTest(null);
  }
});

test("failAlertText: `what` is the caller-supplied middle clause (sibling alerts)", () => {
  try {
    setProfileForTest(profileSchema.parse({ name: "boost" }));
    assert.equal(failAlertText("STALE", "no fresh object"), "🔴 *boost DB backup* STALE — no fresh object");
    assert.equal(
      failAlertText("durable-verify FAILED", "hash mismatch"),
      "🔴 *boost DB backup* durable-verify FAILED — hash mismatch",
    );
  } finally {
    setProfileForTest(null);
  }
});

test("githubRunInfo builds the run URL from the default env vars (null when any is unset)", () => {
  const keys = ["GITHUB_RUN_ID", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY"] as const;
  const orig = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.GITHUB_RUN_ID = "123";
    process.env.GITHUB_SERVER_URL = "https://github.com";
    process.env.GITHUB_REPOSITORY = "o/r";
    assert.deepEqual(githubRunInfo(), { runId: "123", runUrl: "https://github.com/o/r/actions/runs/123" });
    delete process.env.GITHUB_REPOSITORY; // any var missing → no run URL
    assert.deepEqual(githubRunInfo(), { runId: "123", runUrl: null });
  } finally {
    for (const k of keys) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
});
