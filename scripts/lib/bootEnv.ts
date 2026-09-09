// ─────────────────────────────────────────────────────────────────────────────
// Side-effecting boot module — MUST be the FIRST import in every entrypoint.
//
// backupTypes.ts reads `process.env.DISPLAY_TZ` and `process.env.SLOT_MINUTES` at MODULE-LOAD time
// (the latter fixes SLOTS_PER_DAY / HOURS_PER_SLOT / COLS_PER_WEEK and the cadence prose), and
// backupHistory.ts / slack.ts build their Intl.DateTimeFormat instances from DISPLAY_TZ at load too. ES modules
// evaluate a script's imports depth-first in source order, so importing this module first —
// and it imports ONLY lib/profile.js, which imports ONLY yaml + node:fs — guarantees the
// profile's timezone and slot width are bridged into process.env BEFORE any module that captures
// them is loaded.
// (Full profile validation happens later, in each task's load*Config / getProfile.)
// ─────────────────────────────────────────────────────────────────────────────

import { bridgeProfileEnv } from "./profile.js";

bridgeProfileEnv();
