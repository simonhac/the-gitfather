import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyEntryFor, jobLogUrl, renderContext, renderOutcome, tierMarker } from "../../scheduler/src/outcomeRender.js";
import type { JobOutcome } from "../lib/jobOutcome.js";

const outcome = (over: Partial<JobOutcome> = {}): JobOutcome => ({
  version: 1,
  source: "job",
  job: "backup",
  name: "alpha",
  runId: "17000000001",
  runAttempt: 1,
  jobId: "50000000001",
  ok: true,
  exitCode: 0,
  startedAt: "2026-09-27T08:00:30.000Z",
  finishedAt: "2026-09-27T08:02:00.000Z",
  durationMs: 90_000,
  origin: "schedule",
  summary: { kind: "backup", tiers: ["intraday"], bytes: 1234 },
  alerts: [],
  ...over,
});

const ctx = renderContext({
  tz: "Australia/Sydney",
  slotMinutes: 480,
  name: "alpha",
  dashboardUrl: "https://dash.example/alpha/",
  alertMention: "<!here>",
  logUrl: "https://github.com/acme/Alpha/actions/runs/17000000001/job/50000000001",
});

test("jobLogUrl: per-job when the job id is known, else the run page", () => {
  assert.equal(jobLogUrl("o", "r", "1", "2"), "https://github.com/o/r/actions/runs/1/job/2");
  assert.equal(jobLogUrl("o", "r", "1", null), "https://github.com/o/r/actions/runs/1");
});

test("tierMarker: durable tiers only", () => {
  assert.equal(tierMarker(["intraday"]), "");
  assert.equal(tierMarker(["intraday", "daily", "weekly", "monthly"]), "📅`DWM`");
});

test("dailyEntryFor: labelled with when the run STARTED, in the backup's zone", () => {
  // 08:00:30Z is 18:00 in Sydney (AEST, +10).
  assert.deepEqual(dailyEntryFor(outcome(), "Australia/Sydney"), { label: "18:00", ok: true, marker: "", origin: "schedule" });
  assert.deepEqual(dailyEntryFor(outcome({ summary: { kind: "backup", tiers: ["intraday", "daily"], bytes: 1 }, origin: "self-heal" }), "UTC"), {
    label: "08:00",
    ok: true,
    marker: "📅`D`",
    origin: "self-heal",
  });
  // A failed run carries no tier marker, and a missing origin reads as scheduled.
  const failed = dailyEntryFor(outcome({ ok: false, origin: null, summary: null }), "UTC");
  assert.equal(failed.marker, "");
  assert.equal(failed.origin, "schedule");
});

test("renderOutcome: a clean backup is just a row tick", () => {
  const r = renderOutcome(outcome(), ctx);
  assert.ok(r.row);
  assert.equal(r.page, undefined);
  assert.equal(r.warn, undefined);
  assert.equal(r.info, undefined);
  assert.equal(r.webhook, undefined);
});

test("renderOutcome: a failed backup pages with the reason in a code span and a log link", () => {
  const r = renderOutcome(outcome({ ok: false, exitCode: 1, alerts: [{ severity: "page", code: "auth_rejected", text: "credential rejected — PG_BACKUP_DATABASE_URL is stale" }] }), ctx);
  assert.equal(r.row?.ok, false);
  assert.equal(
    r.page,
    "<!here> 🔴 *<https://dash.example/alpha/|alpha DB backup>* FAILED at 18:00 — `credential rejected — PG_BACKUP_DATABASE_URL is stale` · " +
      "<https://github.com/acme/Alpha/actions/runs/17000000001/job/50000000001|job log>",
  );
  assert.match(r.webhook ?? "", /^🔴 PG backup FAILED \(alpha\): credential rejected/);
});

test("renderOutcome: untrusted text cannot mention, link or break out of its code span", () => {
  const evil = "<!channel> see <https://evil.example|here> `x` & more\nline2";
  const r = renderOutcome(outcome({ job: "restoreDrill", summary: null, ok: false, exitCode: 1, alerts: [{ severity: "page", code: "drill_failed", text: evil }] }), ctx);
  const page = r.page ?? "";
  assert.ok(page.startsWith("<!here> "), "the only real mention is the configured one");
  assert.equal(page.match(/<!channel>/g), null);
  assert.ok(page.includes("`&lt;!channel&gt; see &lt;https://evil.example|here&gt; 'x' &amp; more line2`"));
  assert.equal(r.webhook?.includes("<!channel>"), false);
});

test("renderOutcome: several problems become bullets, capped", () => {
  const alerts = Array.from({ length: 11 }, (_, i) => ({ severity: "page" as const, code: "hash_mismatch", text: `mismatch ${i}` }));
  const r = renderOutcome(outcome({ job: "durableVerify", ok: false, exitCode: 1, summary: null, alerts }), ctx);
  const lines = (r.page ?? "").split("\n");
  assert.match(lines[0], /durable-verify FAILED — 11 problems/);
  assert.equal(lines.length, 1 + 8 + 1);
  assert.equal(lines.at(-1), "• …and 3 more");
});

test("renderOutcome: warnings are quiet (no mention)", () => {
  const r = renderOutcome(
    outcome({ job: "durableVerify", summary: null, alerts: [{ severity: "warn", code: "credential_rotation", text: "R2 key is 400d old" }] }),
    ctx,
  );
  assert.equal(r.page, undefined);
  assert.equal(r.warn, "⚠️ *alpha backups* — `R2 key is 400d old`");
});

test("renderOutcome: a failed run with no recorded reason still pages", () => {
  const r = renderOutcome(outcome({ job: "durableVerify", summary: null, ok: false, exitCode: 2 }), ctx);
  assert.match(r.page ?? "", /durable-verify FAILED — `exited with code 2`/);
});

test("renderOutcome: restore-drill OK notice", () => {
  const r = renderOutcome(
    outcome({ job: "restoreDrill", summary: { kind: "restoreDrill", table: "readings", count: 1200, ratio: 0.99, key: "intraday/alpha-20260927T080030Z.dump" } }),
    ctx,
  );
  assert.equal(r.info, "✅ PG restore-drill OK (alpha) — `readings` 1200 (ratio 0.99) — `intraday/alpha-20260927T080030Z.dump`");
});

test("renderOutcome: archive — summary when it did work, 🟠 for refusals/anomalies, 🔴 for a crash", () => {
  const tables = [
    { table: "readings", weeksArchived: 2, rowsArchived: 500, weeksPruned: 1, rowsPruned: 200 },
    { table: "idle", weeksArchived: 0, rowsArchived: 0, weeksPruned: 0, rowsPruned: 0 },
  ];
  const ok = renderOutcome(outcome({ job: "archive", durationMs: 12_300, summary: { kind: "archive", dryRun: "none", tables } }), ctx);
  assert.equal(ok.info, "🗄️ *alpha archive* ok in 12.3s\n`readings`: +2w/500 rows archived, −1w/200 rows pruned");
  const dry = renderOutcome(outcome({ job: "archive", summary: { kind: "archive", dryRun: "source", tables } }), ctx);
  assert.equal(dry.info, undefined);

  const attention = renderOutcome(
    outcome({ job: "archive", ok: false, exitCode: 1, summary: null, alerts: [{ severity: "page", code: "archive_anomaly", text: "week 2026-W30 shrank" }] }),
    ctx,
  );
  assert.match(attention.page ?? "", /^<!here> 🟠 \*<https:\/\/dash\.example\/alpha\/\|alpha DB backup>\* archive needs attention/);
  const crash = renderOutcome(
    outcome({ job: "archive", ok: false, exitCode: 1, summary: null, alerts: [{ severity: "page", code: "archive_failed", text: "connection reset" }] }),
    ctx,
  );
  assert.match(crash.page ?? "", /🔴 .* archive FAILED — `connection reset`/);
});

test("renderContext: a bad mention or dashboard URL from the bucket is neutralised", () => {
  const c = renderContext({ tz: "UTC", slotMinutes: 480, name: "a<b>", dashboardUrl: "javascript:alert(1)", alertMention: "@everyone", logUrl: "https://x|y" });
  assert.equal(c.mention, "<!here>");
  assert.equal(c.row.dashboardUrl, "");
  assert.equal(c.row.name, "a&lt;b&gt;");
  assert.equal(c.logUrl, "");
});
