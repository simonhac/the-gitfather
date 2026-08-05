import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAlert, advanceAlertState, parseAlertState, type AlertState } from "../lib/alert-state.js";
import { formatElapsed } from "../lib/duration.js";

const T0 = Date.UTC(2026, 7, 4, 16, 0, 0); // the first failed slot of the incident this fixes
const min = (n: number) => n * 60_000;

const stateAt = (ms: number, cause: string | null = "auth-rejected"): AlertState => ({
  kind: "stale",
  cause,
  since: new Date(ms).toISOString(),
  lastPagedAt: new Date(ms).toISOString(),
});

test("decide: the first tick of an outage always pages", () => {
  const d = decideAlert(null, T0, "auth-rejected", 60);
  assert.equal(d.page, true);
  assert.equal(d.page && d.reason, "new");
});

test("decide: a tick inside the re-page window stays quiet", () => {
  // The incident: 10-minute ticks for 16 hours = ~96 @here pages that all said the same thing.
  const prev = stateAt(T0);
  for (const afterMin of [10, 20, 30, 40, 50, 59]) {
    const d = decideAlert(prev, T0 + min(afterMin), "auth-rejected", 60);
    assert.equal(d.page, false, `should be quiet ${afterMin}m in`);
    assert.equal(d.page === false && d.nextPageInMinutes, 60 - afterMin);
  }
});

test("decide: the window elapsing re-pages", () => {
  const prev = stateAt(T0);
  assert.equal(decideAlert(prev, T0 + min(60), "auth-rejected", 60).page, true);
  assert.equal(decideAlert(prev, T0 + min(61), "auth-rejected", 60).page, true);
  const d = decideAlert(prev, T0 + min(90), "auth-rejected", 60);
  assert.equal(d.page && d.reason, "repage");
});

test("decide: a CHANGED cause pages immediately, mid-window", () => {
  // A stale credential becoming a truncated dump is new information — never sit on it.
  const prev = stateAt(T0, "auth-rejected");
  const d = decideAlert(prev, T0 + min(5), "connection-reset", 60);
  assert.equal(d.page, true);
  assert.equal(d.page && d.reason, "cause-changed");
});

test("decide: an unknown cause on both sides is not a change", () => {
  const prev = stateAt(T0, null);
  assert.equal(decideAlert(prev, T0 + min(5), null, 60).page, false);
});

test("decide: throttling can be switched off, and never silently swallows a page", () => {
  const prev = stateAt(T0);
  for (const repage of [0, -1]) {
    assert.equal(decideAlert(prev, T0 + min(1), "auth-rejected", repage).page, true, `repage=${repage}`);
  }
});

test("decide: corrupt or absent state fails LOUD, never quiet", () => {
  // Anything we can't read is treated as a new episode: the failure mode of this module must be
  // an extra page, never a missing one.
  const corrupt = { kind: "stale", cause: "auth-rejected", since: "nonsense", lastPagedAt: "nonsense" } as AlertState;
  assert.equal(decideAlert(corrupt, T0 + min(1), "auth-rejected", 60).page, true);
  assert.equal(decideAlert(null, T0, null, 60).page, true);
});

test("advance: a page stamps lastPagedAt but PRESERVES `since` across the episode", () => {
  const prev = stateAt(T0);
  const next = advanceAlertState(prev, T0 + min(60), "auth-rejected", { page: true, reason: "repage" });
  assert.equal(next.since, prev.since, "the episode started when it started");
  assert.equal(next.lastPagedAt, new Date(T0 + min(60)).toISOString());
});

test("advance: a quiet tick leaves lastPagedAt alone (or the window would never elapse)", () => {
  const prev = stateAt(T0);
  const next = advanceAlertState(prev, T0 + min(10), "auth-rejected", { page: false, nextPageInMinutes: 50 });
  assert.equal(next.lastPagedAt, prev.lastPagedAt);
});

test("advance: a changed cause records the new cause but keeps the episode start", () => {
  const prev = stateAt(T0, "auth-rejected");
  const next = advanceAlertState(prev, T0 + min(5), "connection-reset", { page: true, reason: "cause-changed" });
  assert.equal(next.cause, "connection-reset");
  assert.equal(next.since, prev.since);
});

test("advance: with no prior state the episode starts now", () => {
  const next = advanceAlertState(null, T0, "auth-rejected", { page: true, reason: "new" });
  assert.equal(next.since, new Date(T0).toISOString());
  assert.equal(next.lastPagedAt, next.since);
});

test("parse: round-trips a written state, and rejects junk as absent", () => {
  const s = stateAt(T0);
  assert.deepEqual(parseAlertState(JSON.stringify(s)), s);
  for (const junk of ["", "   ", "not json", "null", "[]", '{"kind":"nope"}', '{"cause":"x"}']) {
    assert.equal(parseAlertState(junk), null, `junk: ${junk}`);
  }
});

// ── the "16h 979m old" formatter ─────────────────────────────────────────────

test("formatElapsed: minutes are the REMAINDER, not the total (the 16h 979m bug)", () => {
  assert.equal(formatElapsed(min(979)), "16h 19m"); // the literal string from run 30962954929
  assert.equal(formatElapsed(min(45)), "45m");
  assert.equal(formatElapsed(min(60)), "1h");
  assert.equal(formatElapsed(min(61)), "1h 1m");
  assert.equal(formatElapsed(min(60 * 24)), "1d");
  assert.equal(formatElapsed(min(60 * 24 + 90)), "1d 1h");
  assert.equal(formatElapsed(min(0)), "<1m");
  assert.equal(formatElapsed(-5000), "<1m"); // clock skew must not print "-1h -3m"
});
