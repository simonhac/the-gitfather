// ─────────────────────────────────────────────────────────────────────────────
// Side-effecting boot module — MUST be the FIRST import in every entrypoint.
//
// backupTypes.ts reads `process.env.DISPLAY_TZ` at MODULE-LOAD time (line 31), and
// backupHistory.ts builds its Intl.DateTimeFormat instances from DISPLAY_TZ at load too.
// ES modules evaluate a script's imports depth-first in source order, so importing this
// module before lib/slack.js (which pulls in backupTypes/backupHistory) guarantees the
// profile is in process.env before those constants/formatters are frozen. Loading the
// profile later — e.g. in main() — would be too late and silently fall back to UTC.
// ─────────────────────────────────────────────────────────────────────────────

import { loadProfile } from "./profile.js";

loadProfile();
