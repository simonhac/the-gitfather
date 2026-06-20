import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEnvFile } from "../lib/profile.js";

test("parseEnvFile: quotes, comments, export, inline comments, whitespace", () => {
  const env = parseEnvFile(
    [
      "# a comment",
      "",
      'BACKUP_PREFIX="pg/example"',
      "FILE_BASENAME=example",
      'PG_DUMP_FLAGS="-Fc --no-owner --no-privileges"',
      "  ENCRYPTION='age'  ",
      "STALE_HOURS=5   # inline comment",
      "export GH_THING=bar",
      "EMPTY=",
    ].join("\n"),
  );
  assert.equal(env.BACKUP_PREFIX, "pg/example");
  assert.equal(env.FILE_BASENAME, "example");
  assert.equal(env.PG_DUMP_FLAGS, "-Fc --no-owner --no-privileges"); // spaces preserved inside quotes
  assert.equal(env.ENCRYPTION, "age");
  assert.equal(env.STALE_HOURS, "5"); // inline ` # comment` stripped from a bare value
  assert.equal(env.GH_THING, "bar"); // `export ` prefix stripped
  assert.equal(env.EMPTY, "");
  assert.ok(!("# a comment" in env));
});

test("parseEnvFile: the committed example profile parses to the documented keys", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "../../profiles/example.env"), "utf8");
  const env = parseEnvFile(text);
  assert.equal(env.BACKUP_PREFIX, "pg/example");
  assert.equal(env.FILE_BASENAME, "example");
  assert.equal(env.PG_DUMP_FLAGS, "-Fc --no-owner --no-privileges");
  assert.equal(env.ENCRYPTION, "none");
  assert.equal(env.ANCHOR_HOUR_UTC, "16");
  assert.equal(env.MIN_RATIO, "0.95");
  assert.equal(env.DISPLAY_TZ, "UTC");
  assert.equal(env.DRILL_EXTRA_TABLES, "another_table a_third_table"); // word-split downstream
});
