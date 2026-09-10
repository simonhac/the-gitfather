import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialVerdicts, type LogCredential } from "../lib/credentialAge.js";

const NOW = Date.parse("2026-09-10T00:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number, prefix = "R2"): LogCredential => ({
  ts: new Date(NOW - daysAgo * DAY).toISOString(),
  prefix,
  bucket: "boost-pg-backups",
  repo: "boost-suite/boost",
  keyIdTail: "9f2c",
});

test("a credential inside its window is ok; past it is due", () => {
  const [ok] = credentialVerdicts([at(100)], ["R2"], 365, NOW);
  assert.equal(ok.state, "ok");
  assert.equal(ok.ageDays, 100);

  const [due] = credentialVerdicts([at(447)], ["R2"], 365, NOW);
  assert.equal(due.state, "due");
  assert.equal(due.ageDays, 447);
  assert.match(due.message, /447 days/);
  assert.match(due.message, /365/);
});

test("the boundary is inclusive of the last good day", () => {
  assert.equal(credentialVerdicts([at(365)], ["R2"], 365, NOW)[0].state, "ok");
  assert.equal(credentialVerdicts([at(366)], ["R2"], 365, NOW)[0].state, "due");
});

test("NO RECORD is 'unknown', never 'ok' — the whole point of the check", () => {
  // A credential that has never been rotated through the tool is the one most likely to be
  // ancient. If absence read as fine, the check would be loudest about the credentials someone
  // is already looking after and silent about the one that has sat untouched since 2026-06.
  const [v] = credentialVerdicts([], ["R2"], 365, NOW);
  assert.equal(v.state, "unknown");
  assert.equal(v.ageDays, null);
  assert.match(v.message, /never recorded/i);

  // …and a record for a DIFFERENT prefix does not vouch for this one.
  const [other] = credentialVerdicts([at(1, "DASHBOARD_R2")], ["R2"], 365, NOW);
  assert.equal(other.state, "unknown");
});

test("the NEWEST record wins, whatever order the log is in", () => {
  const records = [at(400), at(12), at(200)];
  assert.equal(credentialVerdicts(records, ["R2"], 365, NOW)[0].ageDays, 12);
  assert.equal(credentialVerdicts([...records].reverse(), ["R2"], 365, NOW)[0].ageDays, 12);
});

test("every tracked prefix gets a verdict, in the order asked", () => {
  const v = credentialVerdicts([at(5), at(500, "DASHBOARD_R2")], ["R2", "DASHBOARD_R2", "R2_READONLY"], 365, NOW);
  assert.deepEqual(v.map((x) => [x.prefix, x.state]), [
    ["R2", "ok"],
    ["DASHBOARD_R2", "due"],
    ["R2_READONLY", "unknown"],
  ]);
});

test("max-age-days 0 disables the check entirely", () => {
  assert.deepEqual(credentialVerdicts([at(9999)], ["R2"], 0, NOW), []);
});

test("a malformed or future timestamp is 'unknown', not a negative age", () => {
  const bad = { ...at(1), ts: "not-a-date" };
  assert.equal(credentialVerdicts([bad], ["R2"], 365, NOW)[0].state, "unknown");
  // Clock skew must not manufacture a fresh-looking credential.
  const future = { ...at(-30), ts: new Date(NOW + 30 * DAY).toISOString() };
  const [v] = credentialVerdicts([future], ["R2"], 365, NOW);
  assert.equal(v.state, "unknown");
  assert.match(v.message, /future/i);
});

test("readLogDir picks up the file appendCredential writes — the writer/reader seam", async () => {
  // If the filename the writer produces and the prefix the reader filters on ever drift, every
  // rotation record becomes invisible and the check reports "never recorded" — which is exactly
  // what a genuinely un-rotated credential reports. "Found nothing" and "couldn't see" would be
  // the same sentence, so pin the two ends together.
  const { readLogDir } = await import("../lib/logStore.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "credlog-"));
  const rec = at(3);
  // The exact name appendRecord("credentials", ts, …) writes: <kind>-YYYY-MM.jsonl.
  const month = rec.ts.slice(0, 7);
  writeFileSync(join(dir, `credentials-${month}.jsonl`), `${JSON.stringify(rec)}\n`);
  writeFileSync(join(dir, `runs-${month}.jsonl`), `${JSON.stringify({ ts: rec.ts, ok: true, tiers: [] })}\n`);
  // Same seam for the archive log: it shares the directory, and every kind must land in its own
  // bucket — a record read into the WRONG array would render as a malformed cell rather than
  // simply going missing, which is harder to notice.
  writeFileSync(
    join(dir, `archives-${month}.jsonl`),
    `${JSON.stringify({ ts: rec.ts, ok: true, table: "public.api_logs", mode: "both", dryRun: "none", weeksArchived: 1, rowsArchived: 10, weeksPruned: 0, rowsPruned: 0, bytes: 99, refusals: 0, anomalies: 0, error: null, durationMs: 1, runId: null, runUrl: null })}\n`,
  );

  const log = readLogDir(dir);
  assert.equal(log.credentials.length, 1, "the credential record was read");
  assert.equal(log.credentials[0].prefix, "R2");
  assert.equal(log.runs.length, 1, "and runs still parse alongside it");
  assert.equal(log.archives.length, 1, "and the archive record lands in its own array");
  assert.equal(log.archives[0].table, "public.api_logs");
  assert.equal(credentialVerdicts(log.credentials, ["R2"], 365, NOW)[0].ageDays, 3);
});
