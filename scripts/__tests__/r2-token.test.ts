import { test } from "node:test";
import assert from "node:assert/strict";
import { secretFromTokenValue, isMate, opFieldNames, parseRollArgs } from "../lib/r2Token.js";

test("secretFromTokenValue is SHA-256 hex of the token value", () => {
  // Cloudflare documents `echo -n "<token>" | shasum -a 256`; this is that, with no trailing newline.
  assert.equal(
    secretFromTokenValue("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(secretFromTokenValue("").length, 64);
  assert.match(secretFromTokenValue("x"), /^[0-9a-f]{64}$/);
  // A trailing newline is a DIFFERENT token as far as the hash is concerned — this is exactly how a
  // copy-paste picks up an invisible character and produces a credential that fails only in CI.
  assert.notEqual(secretFromTokenValue("abc"), secretFromTokenValue("abc\n"));
});

test("isMate: catches halves of two different tokens", () => {
  const value = "s3cr3t-token-value";
  assert.ok(isMate(value, secretFromTokenValue(value)));
  assert.ok(isMate(value, secretFromTokenValue(value).toUpperCase()), "case-insensitive hex");
  assert.ok(isMate(value, `  ${secretFromTokenValue(value)}  `), "tolerates paste whitespace");
  assert.ok(!isMate(value, secretFromTokenValue("a different token")));
  // No secret supplied = nothing to contradict; the caller derives it instead.
  assert.ok(isMate(value, undefined));
});

test("opFieldNames match the env-var names the workflows read", () => {
  // These were three separate 1Password ITEMS until 2026-09-11; they are now three FIELDS of one
  // Secure Note. The names did not change — they are the env vars the workflows read — so the
  // rename here is the item/field distinction, not a change of contract.
  assert.deepEqual(opFieldNames("R2"), {
    accessKeyId: "R2_ACCESS_KEY_ID",
    secretAccessKey: "R2_SECRET_ACCESS_KEY",
    tokenValue: "R2_TOKEN_VALUE",
  });
  assert.equal(opFieldNames("R2_READONLY").secretAccessKey, "R2_READONLY_SECRET_ACCESS_KEY");
});

test("parseRollArgs: --repo is optional, everything else is required", () => {
  const base = ["--vault", "boost-prod", "--bucket", "boost-pg-backups", "--account-id", "acc123"];
  assert.deepEqual(parseRollArgs(base), {
    vault: "boost-prod",
    bucket: "boost-pg-backups",
    accountId: "acc123",
    prefix: "R2",
    repo: null,
    item: "backup",
    dryRun: false,
  });
  assert.equal(parseRollArgs([...base, "--repo", "boost-suite/boost"]).repo, "boost-suite/boost");
  assert.equal(parseRollArgs([...base, "--prefix", "R2_READONLY"]).prefix, "R2_READONLY");
  assert.equal(parseRollArgs([...base, "--dry-run"]).dryRun, true);
  // The destination note defaults to `backup` — the item every client vault now keeps its
  // backup-stack parameters in. Overridable for a vault that uses a different one.
  assert.equal(parseRollArgs([...base, "--item", "env"]).item, "env");
  // A dry run writes nothing, so it must not demand a vault it will never use.
  assert.equal(parseRollArgs(["--bucket", "b", "--account-id", "a", "--dry-run"]).vault, "");
  assert.throws(() => parseRollArgs(["--bucket", "b", "--account-id", "a"]), /--vault/);
  // A flag whose value is missing must not silently swallow the NEXT flag as its value.
  assert.throws(() => parseRollArgs(["--vault", "--bucket", "b", "--account-id", "a"]), /--vault/);
  assert.throws(() => parseRollArgs(["--vault", "v", "--account-id", "a"]), /--bucket/);
  assert.throws(() => parseRollArgs(["--vault", "v", "--bucket", "b"]), /--account-id/);
});
