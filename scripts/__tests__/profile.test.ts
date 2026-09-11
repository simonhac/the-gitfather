import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { deepCamel, buildRawProfile, bridgeDisplayTz, credentialsFromEnv } from "../lib/profile.js";
import { profileSchema } from "../lib/config.js";

test("deepCamel: kebab/snake keys → camelCase, recursively (arrays + scalars untouched)", () => {
  assert.deepEqual(
    deepCamel({ "max-age-hours": 5, dump: { "client-major": 17 }, list: [{ "a-b": 1 }], plain: "x" }),
    { maxAgeHours: 5, dump: { clientMajor: 17 }, list: [{ aB: 1 }], plain: "x" },
  );
});

test("deepCamel: drops null-valued keys (a bare YAML key means 'unset → default', not null)", () => {
  assert.deepEqual(deepCamel({ a: 1, b: null, nested: { c: null, "d-e": 2 } }), { a: 1, nested: { dE: 2 } });
});

test("bare YAML keys (group, scalar, numeric) fall back to defaults — not rejected, not coerced to 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "gf-prof-"));
  const f = join(dir, "p.yaml");
  // retention:/integrity: are bare group headers; dump.min-bytes: is a bare numeric (the dangerous case).
  writeFileSync(f, "name: x\nbackup-prefix: p\nretention:\nintegrity:\ndump:\n  min-bytes:\n");
  const prev = process.env.PROFILE;
  process.env.PROFILE = f;
  try {
    const r = profileSchema.safeParse(buildRawProfile());
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.deepEqual(r.data.retention.father, { days: 91, label: "13 weeks" }); // group default applied
    assert.equal(r.data.dump.minBytes, 1_048_576); // bare numeric → default, NOT silently 0
    assert.equal(r.data.integrity.checksum, true);
  } finally {
    process.env.PROFILE = prev;
  }
});

test("bridgeDisplayTz: sets DISPLAY_TZ from the profile timezone; a bad tz is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "gf-tz-"));
  const prevP = process.env.PROFILE;
  const prevT = process.env.DISPLAY_TZ;
  try {
    const good = join(dir, "good.yaml");
    writeFileSync(good, "timezone: Australia/Perth\n");
    process.env.PROFILE = good;
    delete process.env.DISPLAY_TZ;
    bridgeDisplayTz();
    assert.equal(process.env.DISPLAY_TZ, "Australia/Perth");

    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "timezone: Mars/Phobos\n");
    process.env.PROFILE = bad;
    delete process.env.DISPLAY_TZ;
    bridgeDisplayTz();
    assert.equal(process.env.DISPLAY_TZ, undefined); // invalid tz → left for validation; backupTypes defaults to UTC
  } finally {
    process.env.PROFILE = prevP;
    if (prevT === undefined) delete process.env.DISPLAY_TZ;
    else process.env.DISPLAY_TZ = prevT;
  }
});

test("buildRawProfile: merges YAML config + credentials from env (env owns the credentials namespace)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const prev = { PROFILE: process.env.PROFILE, R2_BUCKET: process.env.R2_BUCKET };
  process.env.PROFILE = join(here, "../../profiles/example.yaml");
  process.env.R2_BUCKET = "secret-bucket";
  try {
    const raw = buildRawProfile() as { name?: string; credentials?: { r2?: { bucket?: string } } };
    assert.equal(raw.name, "example"); // from YAML
    assert.equal(raw.credentials?.r2?.bucket, "secret-bucket"); // from env
  } finally {
    process.env.PROFILE = prev.PROFILE;
    process.env.R2_BUCKET = prev.R2_BUCKET;
  }
});

test("the committed example.yaml validates and applies retention + defaults", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const prev = process.env.PROFILE;
  process.env.PROFILE = join(here, "../../profiles/example.yaml");
  try {
    const r = profileSchema.safeParse(buildRawProfile()); // loose creds → file-only validation passes
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.equal(r.data.name, "example");
    assert.equal(r.data.backupPrefix, "pg/example");
    assert.equal(r.data.anchorHourUtc, 16);
    assert.equal(r.data.dump.minBytes, 1_048_576);
    assert.deepEqual(r.data.retention.father, { days: 91, label: "13 weeks" });
    assert.deepEqual(r.data.retention.grandfather, { days: 730, label: "2 years" });
  } finally {
    process.env.PROFILE = prev;
  }
});

// ─── VERIFY_HEARTBEAT_URL (added 2026-09-12) ───────────────────────────────────────────────────

/** credentialsFromEnv() reads process.env directly, so swap it around the call and restore. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("credentialsFromEnv maps VERIFY_HEARTBEAT_URL, distinctly from HEARTBEAT_URL", () => {
  // The two guard DIFFERENT failures — a backup not landing vs a backup that lands but will not
  // restore — and one caller repo holds both. If these ever collapsed to one name, a green backup
  // would silence a broken restore.
  const creds = withEnv(
    {
      HEARTBEAT_URL: "https://uptime.betterstack.com/api/v1/heartbeat/aaa",
      VERIFY_HEARTBEAT_URL: "https://uptime.betterstack.com/api/v1/heartbeat/bbb",
    },
    () => credentialsFromEnv(),
  );
  assert.equal(creds.heartbeatUrl, "https://uptime.betterstack.com/api/v1/heartbeat/aaa");
  assert.equal(creds.verifyHeartbeatUrl, "https://uptime.betterstack.com/api/v1/heartbeat/bbb");
  assert.notEqual(creds.heartbeatUrl, creds.verifyHeartbeatUrl);
});

test("verifyHeartbeatUrl is unset-means-off", () => {
  const creds = withEnv({ VERIFY_HEARTBEAT_URL: undefined }, () => credentialsFromEnv());
  assert.equal(creds.verifyHeartbeatUrl, undefined);
});
