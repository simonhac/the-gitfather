// ─────────────────────────────────────────────────────────────────────────────
// Profile (.env) loading + env-var access for the ported scripts.
//
// Profiles stay bash-sourceable `KEY="value"` files (profiles/*.env): they are ALSO
// `set -a; source`d by the workflows' "Read profile" steps and documented in the README,
// so the format must not change. We parse the simple subset here (KEY=value / KEY="value"
// / KEY='value', # comments, optional `export`) rather than exec'ing bash.
//
// Merge policy: profile values fill in only env vars that are not ALREADY set, so real
// environment/secrets (R2_*, PG_BACKUP_DATABASE_URL, the workflow `env:` block) always win
// — matching the bash split where credentials come from the environment, config from the
// profile. See lib/bootEnv.ts for why loading must happen before other imports.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

/** Parse the simple bash-assignment subset used by profiles/*.env into a plain object. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'")) {
      const q = val[0];
      const end = val.indexOf(q, 1);
      val = end >= 0 ? val.slice(1, end) : val.slice(1); // strip surrounding quotes
    } else {
      // Bare value: drop an inline ` # comment` (must be whitespace-preceded, bash-style).
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

/** Load the $PROFILE file (default process.env.PROFILE) into process.env without clobbering existing keys. */
export function loadProfile(path: string | undefined = process.env.PROFILE): void {
  if (!path) return;
  const vars = parseEnvFile(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// requireEnv / numEnv / wordsEnv (presence-only reads) were retired in favour of the zod-validated,
// typed per-task config in lib/config.ts, which checks presence AND grammar/range in one aggregated
// pass. parseEnvFile + loadProfile remain the .env front door (used by bootEnv.ts and config.ts).
