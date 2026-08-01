// ─────────────────────────────────────────────────────────────────────────────
// Emit the handful of profile values that a CI *bash* step needs (YAML can't be
// `source`d like the old .env profiles). Reads $PROFILE tolerantly (no validation,
// never exits non-zero on a soft-missing value) and prints `KEY=value` lines for
// appending to $GITHUB_ENV:
//
//   PROFILE=…/profile.yaml npx tsx scripts/profile-export.ts >> "$GITHUB_ENV"
//
// Emits PG_CLIENT_MAJOR (for the pg-client install in setup-tools) and ENCRYPTION
// (so setup-tools can install the `age` CLI only when it's actually needed), plus
// ARCHIVE_ENCRYPTION / ARCHIVE_COMPRESSION — the archive block picks its own tools,
// because its age recipient is a DIFFERENT one from the dump's (see config.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { buildRawProfile } from "./lib/profile.js";

const raw = buildRawProfile() as {
  dump?: { clientMajor?: unknown };
  encryption?: unknown;
  archive?: { encryption?: unknown; compression?: unknown };
};
const clientMajor = raw.dump?.clientMajor;
const pgClientMajor = typeof clientMajor === "number" || typeof clientMajor === "string" ? clientMajor : 17;
const encryption = typeof raw.encryption === "string" ? raw.encryption : "none";

// The archive block is optional; default to what archive.ts's schema defaults to.
const archiveEncryption = typeof raw.archive?.encryption === "string" ? raw.archive.encryption : "age";
const archiveCompression = typeof raw.archive?.compression === "string" ? raw.archive.compression : "zstd";

process.stdout.write(`PG_CLIENT_MAJOR=${pgClientMajor}\n`);
process.stdout.write(`ENCRYPTION=${encryption}\n`);
process.stdout.write(`ARCHIVE_ENCRYPTION=${archiveEncryption}\n`);
process.stdout.write(`ARCHIVE_COMPRESSION=${archiveCompression}\n`);
