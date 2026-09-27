import { test } from "node:test";
import assert from "node:assert/strict";
import { backupSchema } from "../lib/config.js";
import { parseWatchdogConfig, watchdogConfigFrom, watchdogConfigKey, WATCHDOG_CONFIG_VERSION } from "../lib/watchdogConfig.js";

// The object the backup publishes for the Worker's watchdog: built from a validated profile, then
// read back by the same parser the Worker bundles. A round trip here is the contract between runtimes.

const r2 = { accountId: "acct", bucket: "my-bucket", accessKeyId: "k", secretAccessKey: "s" };
const base = {
  name: "example",
  backupPrefix: "pg/example",
  timezone: "Australia/Perth",
  credentials: { databaseUrl: "postgres://u:p@h:5432/db?sslmode=require", r2 },
};
const NOW = new Date(Date.UTC(2026, 8, 10, 3, 0, 0));

test("watchdog config: a validated profile round-trips through publish → parse with defaults applied", () => {
  const cfg = backupSchema.parse(base);
  const published = watchdogConfigFrom(cfg, NOW);
  assert.equal(published.version, WATCHDOG_CONFIG_VERSION);
  assert.equal(published.name, "example");
  assert.equal(published.backupPrefix, "pg/example");
  assert.equal(published.timezone, "Australia/Perth");
  assert.equal(published.slotMinutes, 480);
  assert.equal(published.anchorHourUtc, 16);
  assert.equal(published.graceMinutes, 25);
  assert.equal(published.maxAgeHours, 12); // derived backstop
  assert.equal(published.repageMinutes, 60);
  assert.equal(published.minBytes, 1048576);
  assert.equal(published.selfHeal, true);
  assert.equal(published.dryRun, false);
  assert.equal(published.healWorkflow, "pg-backup.yml");
  assert.equal(published.alertMention, "<!here>");
  assert.equal(published.dashboardUrl, null);
  assert.equal(published.archives, false, "no archive tables → owes no archive proof");
  assert.equal(published.publishedAt, "2026-09-10T03:00:00.000Z");

  const parsed = parseWatchdogConfig(JSON.stringify(published));
  assert.deepEqual(parsed, published);
});

test("watchdog config: no Slack channel is published — the channel lives in the scheduler's roster", () => {
  const published = watchdogConfigFrom(backupSchema.parse(base), NOW);
  assert.ok(!("slackChannel" in published));
  // A copy published by an older engine still carries one; the parser ignores it rather than refusing.
  const legacy = parseWatchdogConfig(JSON.stringify({ ...published, slackChannel: "C111" }));
  assert.ok(legacy);
  assert.ok(!("slackChannel" in legacy));
});

test("watchdog config: alert-mention is published as-is when safe, and reads back as the default when not", () => {
  const pinged = watchdogConfigFrom(backupSchema.parse({ ...base, slack: { alertMention: "<!subteam^S0123ABCD>" } }), NOW);
  assert.equal(pinged.alertMention, "<!subteam^S0123ABCD>");
  assert.equal(parseWatchdogConfig(JSON.stringify(pinged))?.alertMention, "<!subteam^S0123ABCD>");
  // Anyone holding the bucket key can rewrite the published copy, so the Worker never trusts it.
  for (const bad of ["<!everyone>", "<https://evil.example|click>", "@here", "<!here> hi"]) {
    assert.equal(parseWatchdogConfig(JSON.stringify({ ...pinged, alertMention: bad }))?.alertMention, "<!here>", bad);
  }
});

test("watchdog config: the parser refuses anything the watchdog cannot run on (→ no-config, never a guess)", () => {
  const good = watchdogConfigFrom(backupSchema.parse(base), NOW);
  const mutate = (patch: Record<string, unknown>) => parseWatchdogConfig(JSON.stringify({ ...good, ...patch }));
  assert.equal(parseWatchdogConfig(""), null);
  assert.equal(parseWatchdogConfig("{not json"), null);
  assert.equal(parseWatchdogConfig("[]"), null);
  assert.equal(mutate({ version: 2 }), null);
  assert.equal(mutate({ name: "" }), null);
  assert.equal(mutate({ backupPrefix: undefined }), null);
  assert.equal(mutate({ slotMinutes: 100 }), null); // must divide 1440
  assert.equal(mutate({ slotMinutes: 90 }), null); // …in whole hours
  assert.equal(mutate({ anchorHourUtc: 24 }), null);
  assert.equal(mutate({ slotMinutes: "480" }), null);
  assert.equal(mutate({ maxAgeHours: 0 }), null);
  assert.equal(mutate({ selfHeal: "yes" }), null);
  assert.equal(mutate({ healWorkflow: "" }), null);
  // Tolerant where tolerance is safe: extra keys, a trailing slash on the prefix, blank optionals.
  const lenient = mutate({ future: 1, backupPrefix: "pg/example/", dashboardUrl: "", alertMention: "" });
  assert.ok(lenient);
  assert.equal(lenient.backupPrefix, "pg/example");
  assert.equal(lenient.dashboardUrl, null);
  assert.equal(lenient.alertMention, "<!here>");
});

test("watchdog config: the cadence and anchor ride along; a pre-anchor config defaults to 16", () => {
  const daily = watchdogConfigFrom(backupSchema.parse({ ...base, backupsPerDay: 1, anchorHourUtc: 5 }), NOW);
  assert.equal(daily.slotMinutes, 1440);
  assert.equal(daily.anchorHourUtc, 5);
  assert.equal(parseWatchdogConfig(JSON.stringify(daily))?.anchorHourUtc, 5);
  const old: Partial<typeof daily> = { ...daily };
  delete old.anchorHourUtc;
  assert.equal(parseWatchdogConfig(JSON.stringify(old))?.anchorHourUtc, 16);
});

test("watchdog config: one object per backup name, under _config/", () => {
  assert.equal(watchdogConfigKey("example"), "_config/example/watchdog.json");
});

test("watchdog config: `archives` says whether this database owes an archive proof, and is optional on read", () => {
  const archiving = backupSchema.parse({
    ...base,
    archive: { storePrefix: "archive/example", tables: [{ table: "public.api_logs", timeColumn: "created_at" }] },
  });
  const published = watchdogConfigFrom(archiving, NOW);
  assert.equal(published.archives, true);
  assert.equal(parseWatchdogConfig(JSON.stringify(published))?.archives, true);

  // A config published before the field existed: undefined, so the roster alone decides.
  const { archives: _drop, ...legacy } = published;
  void _drop;
  assert.equal(parseWatchdogConfig(JSON.stringify(legacy))?.archives, undefined);
});
