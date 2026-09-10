// ─────────────────────────────────────────────────────────────────────────────
// How a backup run was started — a leaf type shared by the Node scripts, the browser bundle and the
// Cloudflare Worker (which bundles schedule.ts / dailyRow.ts and must not pull in backupTypes.ts,
// whose module load reads process.env). backupTypes.ts re-exports it.
// ─────────────────────────────────────────────────────────────────────────────

/** schedule → no marker · manual → 🖐️ (GitHub-UI "Run workflow" / local run) · self-heal → 🩹 (the watchdog's catch-up). */
export type RunOrigin = "schedule" | "manual" | "self-heal";
