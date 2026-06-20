import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePgMajor, configureRcloneRemote, checkBinary } from "../lib/preflight.js";

test("parsePgMajor: extracts the major version across common --version shapes", () => {
  assert.equal(parsePgMajor("pg_dump (PostgreSQL) 17.2 (Homebrew)"), 17);
  assert.equal(parsePgMajor("pg_dump (PostgreSQL) 16.4"), 16);
  assert.equal(parsePgMajor("pg_restore (PostgreSQL) 15.6 (Debian 15.6-1.pgdg120+1)"), 15);
  assert.equal(parsePgMajor("pg_dump (PostgreSQL) 18beta1"), 18); // "(PostgreSQL)" stripped first
  assert.equal(parsePgMajor("no digits here"), null);
});

test("configureRcloneRemote: sets the RCLONE_CONFIG_<REMOTE>_* env from creds", () => {
  const keys = [
    "RCLONE_CONFIG_R2DASH_TYPE",
    "RCLONE_CONFIG_R2DASH_PROVIDER",
    "RCLONE_CONFIG_R2DASH_ACCESS_KEY_ID",
    "RCLONE_CONFIG_R2DASH_SECRET_ACCESS_KEY",
    "RCLONE_CONFIG_R2DASH_ENDPOINT",
  ];
  for (const k of keys) delete process.env[k];
  try {
    configureRcloneRemote("r2dash", "acct123", "AKIA", "shhh");
    assert.equal(process.env.RCLONE_CONFIG_R2DASH_TYPE, "s3");
    assert.equal(process.env.RCLONE_CONFIG_R2DASH_PROVIDER, "Cloudflare");
    assert.equal(process.env.RCLONE_CONFIG_R2DASH_ACCESS_KEY_ID, "AKIA");
    assert.equal(process.env.RCLONE_CONFIG_R2DASH_SECRET_ACCESS_KEY, "shhh");
    assert.equal(process.env.RCLONE_CONFIG_R2DASH_ENDPOINT, "https://acct123.r2.cloudflarestorage.com");
  } finally {
    for (const k of keys) delete process.env[k];
  }
});

test("checkBinary: ok for a present binary, not-ok for a bogus one; optional flag propagates", () => {
  const present = checkBinary("node");
  assert.equal(present.ok, true);
  assert.equal(present.name, "binary: node");

  const absent = checkBinary("definitely-not-a-real-binary-xyz");
  assert.equal(absent.ok, false);
  assert.equal(absent.optional, false);

  const absentOptional = checkBinary("definitely-not-a-real-binary-xyz", true);
  assert.equal(absentOptional.ok, false);
  assert.equal(absentOptional.optional, true);
});
