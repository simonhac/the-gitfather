import { test } from "node:test";
import assert from "node:assert/strict";
import { clientForRepository, parseRoster, slackIdentity, type Client } from "../../scheduler/src/roster.js";

const has = (b: string) => b.endsWith("_R2");
const base = { id: "alpha", owner: "org", repo: "app", installationId: 1, bucket: "ALPHA_R2" };
const parse = (entries: unknown[]) => parseRoster(entries, has);

test("parseRoster: accepts a JSON string or an array", () => {
  assert.equal(parse([base]).length, 1);
  assert.equal(parseRoster(JSON.stringify([base]), has).length, 1);
});

test("parseRoster: the existing checks still hold", () => {
  assert.throws(() => parseRoster({}, has), /JSON array/);
  assert.throws(() => parse([{ ...base, id: "" }]), /non-empty id/);
  assert.throws(() => parse([base, { ...base, repo: "other" }]), /duplicated/);
  assert.throws(() => parse([{ ...base, installationId: 0 }]), /installationId/);
  assert.throws(() => parse([{ ...base, bucket: "NOPE" }]), /no R2 binding/);
});

test("parseRoster: one repo can't be two clients (/notify finds the client by repo)", () => {
  assert.throws(() => parse([base, { ...base, id: "beta", owner: "ORG", repo: "APP" }]), /already in the roster/);
});

test("parseRoster: repositoryId, when set, is a positive integer", () => {
  assert.equal(parse([{ ...base, repositoryId: 123 }])[0].repositoryId, 123);
  assert.throws(() => parse([{ ...base, repositoryId: "123" }]), /repositoryId/);
  assert.throws(() => parse([{ ...base, repositoryId: -1 }]), /repositoryId/);
});

test("parseRoster: the slack block", () => {
  const ok = (slack: unknown) => parse([{ ...base, slack }])[0].slack;
  assert.deepEqual(ok({ channel: "C0B9JP3BLE4" }), { channel: "C0B9JP3BLE4" });
  assert.ok(ok({ channel: "C0B9JP3BLE4", username: "alpha backup", iconEmoji: ":floppy_disk:" }));
  assert.ok(ok({ channel: "G0B9JP3BLE4", iconUrl: "https://example.com/i.png" }));

  const bad: [unknown, RegExp][] = [
    ["C0B9JP3BLE4", /must be an object/],
    [{}, /slack.channel/],
    [{ channel: "#backups" }, /slack.channel/],
    [{ channel: "C0B9JP3BLE4", icon: ":x:" }, /unknown slack key/],
    [{ channel: "C0B9JP3BLE4", username: "" }, /username/],
    [{ channel: "C0B9JP3BLE4", username: "<!channel>" }, /username/],
    [{ channel: "C0B9JP3BLE4", username: "x".repeat(81) }, /username/],
    [{ channel: "C0B9JP3BLE4", iconEmoji: "floppy" }, /iconEmoji/],
    [{ channel: "C0B9JP3BLE4", iconUrl: "http://example.com/i.png" }, /iconUrl/],
    [{ channel: "C0B9JP3BLE4", iconEmoji: ":a:", iconUrl: "https://example.com/i.png" }, /not both/],
  ];
  for (const [slack, re] of bad) assert.throws(() => parse([{ ...base, slack }]), re, JSON.stringify(slack));
});

test("slackIdentity: defaults to '<id> backup' and the app's own icon", () => {
  const c = base as Client;
  assert.deepEqual(slackIdentity(c), { username: "alpha backup" });
  assert.deepEqual(slackIdentity({ ...c, slack: { channel: "C0B9JP3BLE4", username: "Alpha DB", iconEmoji: ":elephant:" } }), {
    username: "Alpha DB",
    icon_emoji: ":elephant:",
  });
  assert.deepEqual(slackIdentity({ ...c, slack: { channel: "C0B9JP3BLE4", iconUrl: "https://x.example/i.png" } }), {
    username: "alpha backup",
    icon_url: "https://x.example/i.png",
  });
});

test("clientForRepository: case-insensitive, exact", () => {
  const clients = parse([base, { ...base, id: "beta", repo: "app2" }]);
  assert.equal(clientForRepository(clients, "ORG/App")?.id, "alpha");
  assert.equal(clientForRepository(clients, "org/app2")?.id, "beta");
  assert.equal(clientForRepository(clients, "org/app3"), null);
  assert.equal(clientForRepository(clients, "org/ap"), null);
});
