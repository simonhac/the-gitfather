// ─────────────────────────────────────────────────────────────────────────────
// Publish the watchdog config to R2 (Actions-side, rclone) — see watchdogConfig.ts for why the
// backup, not the Worker, is the one that moves config across the GitHub → Cloudflare boundary.
// Best-effort: a failed publish is warned about and never fails a backup; the Worker keeps using
// the previous publication.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./proc.js";
import { resolvedSlackChannel, type Profile } from "./config.js";
import { watchdogConfigFrom, watchdogConfigKey } from "./watchdogConfig.js";

/** Write `_config/<name>/watchdog.json` to the profile's R2 bucket (RCLONE_CONFIG_R2_* must already be set). */
export function publishWatchdogConfig(cfg: Profile, now: Date = new Date()): boolean {
  const bucket = cfg.credentials.r2.bucket;
  const name = cfg.name;
  if (!bucket || !name) return false;
  const body = JSON.stringify(watchdogConfigFrom(cfg, now, resolvedSlackChannel(cfg)), null, 2);
  const file = join(tmpdir(), `watchdog-config-${process.pid}.json`);
  writeFileSync(file, body);
  try {
    const put = capture("rclone", ["copyto", file, `r2:${bucket}/${watchdogConfigKey(name)}`, "--s3-no-check-bucket"]);
    if (!put.ok) process.stderr.write(`warning: could not publish the watchdog config to R2\n`);
    else process.stdout.write(`watchdog config published → ${watchdogConfigKey(name)}\n`);
    return put.ok;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}
