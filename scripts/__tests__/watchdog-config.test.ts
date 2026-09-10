import { test } from "node:test";
import assert from "node:assert/strict";
import { backupSchema, resolvedSlackChannel } from "../lib/config.js";
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
  const published = watchdogConfigFrom(cfg, NOW, resolvedSlackChannel(cfg));
  assert.equal(published.version, WATCHDOG_CONFIG_VERSION);
  assert.equal(published.name, "example");
  assert.equal(published.backupPrefix, "pg/example");
  assert.equal(published.timezone, "Australia/Perth");
  assert.equal(published.slotMinutes, 480);
  assert.equal(published.graceMinutes, 25);
  assert.equal(published.maxAgeHours, 12); // derived backstop
  assert.equal(published.repageMinutes, 60);
  assert.equal(published.minBytes, 1048576);
  assert.equal(published.selfHeal, true);
  assert.equal(published.dryRun, false);
  assert.equal(published.healWorkflow, "pg-backup.yml");
  assert.equal(published.slackChannel, null); // no channel anywhere → Slack off for the watchdog
  assert.equal(published.alertMention, "<!here>");
  assert.equal(published.dashboardUrl, null);
  assert.equal(published.publishedAt, "2026-09-10T03:00:00.000Z");

  const parsed = parseWatchdogConfig(JSON.stringify(published));
  assert.deepEqual(parsed, published);
});

test("watchdog config: the Slack channel comes from env SLACK_CHANNEL first, else the profile's slack.channel", () => {
  const fromProfile = backupSchema.parse({ ...base, slack: { channel: "C111" } });
  assert.equal(resolvedSlackChannel(fromProfile), "C111");
  const fromEnv = backupSchema.parse({ ...base, slack: { channel: "C111" }, credentials: { ...base.credentials, slackChannel: "C222" } });
  assert.equal(resolvedSlackChannel(fromEnv), "C222");
  assert.equal(watchdogConfigFrom(fromEnv, NOW, resolvedSlackChannel(fromEnv)).slackChannel, "C222");
});

test("watchdog config: a bot token needs a channel from EITHER source", () => {
  const creds = { ...base.credentials, slackToken: "xoxb-1" };
  assert.ok(!backupSchema.safeParse({ ...base, credentials: creds }).success);
  assert.ok(backupSchema.safeParse({ ...base, credentials: creds, slack: { channel: "C111" } }).success);
  assert.ok(backupSchema.safeParse({ ...base, credentials: { ...creds, slackChannel: "C222" } }).success);
});

test("watchdog config: the parser refuses anything the watchdog cannot run on (→ no-config, never a guess)", () => {
  const good = watchdogConfigFrom(backupSchema.parse(base), NOW, "");
  const mutate = (patch: Record<string, unknown>) => parseWatchdogConfig(JSON.stringify({ ...good, ...patch }));
  assert.equal(parseWatchdogConfig(""), null);
  assert.equal(parseWatchdogConfig("{not json"), null);
  assert.equal(parseWatchdogConfig("[]"), null);
  assert.equal(mutate({ version: 2 }), null);
  assert.equal(mutate({ name: "" }), null);
  assert.equal(mutate({ backupPrefix: undefined }), null);
  assert.equal(mutate({ slotMinutes: 100 }), null); // must divide 1440
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

test("watchdog config: one object per backup name, under _config/", () => {
  assert.equal(watchdogConfigKey("example"), "_config/example/watchdog.json");
});
