import { test } from "node:test";
import assert from "node:assert/strict";

// slack.ts captures DISPLAY_TZ at MODULE LOAD (the bootEnv.ts contract), so the timezone must be set
// before the first import of it — hence the dynamic import below, and hence this living in its own
// file rather than in slack-render.test.ts (which imports slack.js statically, pinning it to UTC).
// node:test runs each test file in its own process, so this env write can't leak into siblings.
process.env.DISPLAY_TZ = "Australia/Sydney";
const { dailyHeader } = await import("../lib/slack.js");
const { setProfileForTest, profileSchema } = await import("../lib/config.js");

test("dailyHeader: full date + timezone tail in a non-UTC DISPLAY_TZ", () => {
  try {
    setProfileForTest(profileSchema.parse({ name: "liveone" }));
    // 04:00 UTC on 18 Aug 2026 = 14:00 Tue 18 Aug in Sydney, in AEST (not AEDT).
    assert.equal(
      dailyHeader(new Date("2026-08-18T04:00:00Z")),
      "*liveone DB backup — Tue 18 Aug 2026 (AEST)*",
    );
    // Southern DST: same zone, January → AEDT, and the date rolls to the 19th (15:00 local).
    assert.equal(
      dailyHeader(new Date("2026-01-19T04:00:00Z")),
      "*liveone DB backup — Mon 19 Jan 2026 (AEDT)*",
    );
  } finally {
    setProfileForTest(null); // don't leak the injected profile into sibling tests
  }
});
