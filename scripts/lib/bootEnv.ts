// ─────────────────────────────────────────────────────────────────────────────
// Side-effecting boot module — MUST be the FIRST import in every entrypoint.
//
// backupTypes.ts reads `process.env.DISPLAY_TZ` at MODULE-LOAD time, and backupHistory.ts /
// slack.ts build their Intl.DateTimeFormat instances from DISPLAY_TZ at load too. ES modules
// evaluate a script's imports depth-first in source order, so importing this module first —
// and it imports ONLY lib/profile.js, which imports ONLY yaml + node:fs — guarantees the
// profile's timezone is bridged into process.env BEFORE any module that captures it is loaded.
// (Full profile validation happens later, in each task's load*Config / getProfile.)
// ─────────────────────────────────────────────────────────────────────────────

import { bridgeDisplayTz } from "./profile.js";

bridgeDisplayTz();
