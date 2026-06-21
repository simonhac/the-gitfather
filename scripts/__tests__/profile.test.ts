import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepCamel, buildRawProfile } from "../lib/profile.js";
import { profileSchema } from "../lib/config.js";

test("deepCamel: kebab/snake keys → camelCase, recursively (arrays + scalars untouched)", () => {
  assert.deepEqual(
    deepCamel({ "max-age-hours": 5, dump: { "client-major": 17 }, list: [{ "a-b": 1 }], plain: "x" }),
    { maxAgeHours: 5, dump: { clientMajor: 17 }, list: [{ aB: 1 }], plain: "x" },
  );
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
