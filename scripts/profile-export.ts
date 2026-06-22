// ─────────────────────────────────────────────────────────────────────────────
// Emit the handful of profile values that a CI *bash* step needs (YAML can't be
// `source`d like the old .env profiles). Reads $PROFILE tolerantly (no validation,
// never exits non-zero on a soft-missing value) and prints `KEY=value` lines for
// appending to $GITHUB_ENV:
//
//   PROFILE=…/profile.yaml npx tsx scripts/profile-export.ts >> "$GITHUB_ENV"
//
// Emits PG_CLIENT_MAJOR (for the pg-client install in setup-tools) and ENCRYPTION
// (so setup-tools can install the `age` CLI only when it's actually needed).
// ─────────────────────────────────────────────────────────────────────────────

import { buildRawProfile } from "./lib/profile.js";

const raw = buildRawProfile() as { dump?: { clientMajor?: unknown }; encryption?: unknown };
const clientMajor = raw.dump?.clientMajor;
const pgClientMajor = typeof clientMajor === "number" || typeof clientMajor === "string" ? clientMajor : 17;
const encryption = typeof raw.encryption === "string" ? raw.encryption : "none";

process.stdout.write(`PG_CLIENT_MAJOR=${pgClientMajor}\n`);
process.stdout.write(`ENCRYPTION=${encryption}\n`);
