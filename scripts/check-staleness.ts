import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// Staleness check — asserts a fresh backup has landed, self-heals a missed run, and keeps the Slack
// status row honest. Complements the backup script's dead-man's-switch ping: this one asserts an
// *object* actually landed; the ping asserts a *run succeeded*. Together they also catch the
// workflow not firing.
//
// Lists the newest object under $backup-prefix/2hourly/ and derives its age from the timestamped key.
// Each run it also refreshes today's Slack row (renders ⬜ for elapsed-but-empty 2-hourly buckets).
// Freshness is slot-based: if the CURRENT cadence slot (staleness.slot-minutes) still has no backup once
// staleness.grace-minutes past its boundary, it calls onStale() — so a missed tick is caught ~grace minutes
// later, not after the multi-hour max-age wait. staleness.max-age-hours is only a backstop (pages if the
// slot math is misconfigured). GitHub Actions cron is best-effort, so the default assumption is a *missed*
// tick and it re-triggers the backup once — but only when the last run succeeded (a *broken* backup is
// paged, not retried, to avoid a trigger loop).
//
// Usage:
//   PROFILE=profiles/example.yaml npx tsx scripts/check-staleness.ts
//
// Required env: R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
// Optional env: SLACK_BOT_TOKEN / SLACK_CHANNEL ; GH_TOKEN / GITHUB_REPOSITORY (self-heal); other config from $PROFILE;
//               profile: staleness.self-heal=false (alert only) ; staleness.dry-run=true (log, don't fire)
// ─────────────────────────────────────────────────────────────────────────────

import { loadStalenessConfig } from "./lib/config.js";
import { run, capture, commandExists } from "./lib/proc.js";
import { backupLooksBroken, slotState, stampToEpochMs } from "./lib/schedule.js";
import { slackOneoff, slackDailyRefresh, alertWebhook } from "./lib/slack.js";

async function main(): Promise<void> {
  // Validate + type all config up front (zod); fails fast with one aggregated report. See lib/config.ts.
  const cfg = loadStalenessConfig();
  // R2 creds + name/backup-prefix are guaranteed present by stalenessSchema's refinements (non-null below).
  const backupPrefix = cfg.backupPrefix!;
  const fileBasename = cfg.name!;
  const r2Account = cfg.credentials.r2.accountId!;
  const r2Bucket = cfg.credentials.r2.bucket!;
  const r2Key = cfg.credentials.r2.accessKeyId!;
  const r2Secret = cfg.credentials.r2.secretAccessKey!;
  const staleHours = cfg.staleness.maxAgeHours;
  const slotMinutes = cfg.staleness.slotMinutes;
  const graceMinutes = cfg.staleness.graceMinutes;
  const minBytes = cfg.dump.minBytes;
  const backupWorkflow = cfg.staleness.healWorkflow;

  const endpoint = `https://${r2Account}.r2.cloudflarestorage.com`;

  const fail = async (msg: string): Promise<never> => {
    process.stderr.write(`ERROR: ${msg}\n`);
    await slackOneoff(`🔴 PG backup STALE (${fileBasename}): ${msg}`, true).catch(() => {});
    await alertWebhook(`🔴 PG backup STALE (${fileBasename}): ${msg}`).catch(() => {});
    process.exit(1);
  };
  const note = async (msg: string): Promise<void> => {
    process.stderr.write(`${msg}\n`);
    await slackOneoff(msg).catch(() => {}); // quiet (no mention) — for self-heal progress
  };

  // onStale — handle a stale newest backup. Default assumption: a tick was MISSED → self-heal by
  // re-triggering the backup. The one thing we must NOT do is hammer a *persistently* BROKEN backup — so
  // we refuse to retry only when the backup is failing repeatedly, not on a single noisy run. In order:
  //   1. no gh / repo context / staleness.self-heal off → can't self-heal, page loudly.
  //   2. a backup already queued/running → let it finish, don't pile up.
  //   3. the two most recent COMPLETED runs both failed → broken, not missed → page loudly, do NOT retry.
  //   4. otherwise (last completed ok, a single failure, or none) → trigger ONE catch-up backup, quiet note.
  // No persistent state: a single failure still self-heals; if the catch-up also fails, the *next* check
  // sees two consecutive failures and takes path 3 (loud). At most one trigger per invocation.
  const onStale = async (msg: string): Promise<never> => {
    process.stderr.write(`STALE: ${msg}\n`);

    if (!cfg.staleness.selfHeal || !commandExists("gh") || !process.env.GITHUB_REPOSITORY) {
      return fail(msg);
    }

    // One query feeds both checks: recent runs with status (for in-flight) + conclusion (broken vs missed).
    let runs: { status?: string; conclusion?: string | null }[] = [];
    const runsRes = capture("gh", ["run", "list", `--workflow=${backupWorkflow}`, "--limit", "10", "--json", "status,conclusion"]);
    if (runsRes.ok) {
      try {
        runs = JSON.parse(runsRes.out) as { status?: string; conclusion?: string | null }[];
      } catch {
        /* gh output unparseable → [] (none in-flight, retry-eligible), like the bash empty-string path */
      }
    }

    const inflight = runs.filter((r) => r.status === "in_progress" || r.status === "queued").length;
    if (inflight !== 0) {
      await note(`🟡 PG backup STALE (${fileBasename}): ${msg} — a backup is already running; waiting it out.`);
      process.exit(0);
    }

    // Broken vs missed: refuse to retry only when the backup is *persistently* failing (two most recent
    // COMPLETED runs both failed). A single failure is a transient miss → still self-heal; if the catch-up
    // also fails, the next check sees two consecutive failures and pages here. See backupLooksBroken().
    if (backupLooksBroken(runs)) {
      const failed = runs.find((r) => r.status === "completed")?.conclusion || "failure";
      return fail(`${msg} — backup failing repeatedly (latest \`${failed}\`); not auto-retrying (broken, not missed).`);
    }
    const last = runs.find((r) => r.status === "completed")?.conclusion || ""; // newest completed verdict, for the notes below

    if (cfg.staleness.dryRun) {
      await note(
        `🟡 [dry-run] PG backup STALE (${fileBasename}): ${msg} — would trigger a catch-up backup (last run \`${last || "none"}\`).`,
      );
      process.exit(0);
    }

    // Tag the catch-up as a self-heal so the Slack row shows 🩹 (not 🖐️). Tolerant of a caller that
    // hasn't yet declared the `reason` workflow_dispatch input (cross-repo rollout): on a non-zero exit
    // (e.g. HTTP 422 "Unexpected inputs"), retry once without -f — self-heal still fires, marked 🖐️.
    let code = await run("gh", ["workflow", "run", backupWorkflow, "-f", "reason=self-heal"], { stdio: "ignore" });
    if (code !== 0) {
      // stdio:"ignore" swallowed gh's own error; surface a hint so a half-rolled-out caller (one missing
      // the `reason` input) is diagnosable rather than silently degrading to a 🖐️ catch-up indefinitely.
      process.stderr.write(
        `note: \`gh workflow run ${backupWorkflow} -f reason=self-heal\` failed; retrying without -f ` +
          `(caller may not yet declare the \`reason\` workflow_dispatch input — catch-up will show 🖐️, not 🩹).\n`,
      );
      code = await run("gh", ["workflow", "run", backupWorkflow], { stdio: "ignore" });
    }
    if (code === 0) {
      await note(
        `🟡 PG backup STALE (${fileBasename}): ${msg} — triggered a catch-up backup (last run \`${last || "none"}\`). Will page if it doesn't recover.`,
      );
      process.exit(0);
    }
    return fail(`${msg} — and the catch-up trigger (\`gh workflow run ${backupWorkflow}\`) failed.`);
  };

  if (!commandExists("rclone")) await fail("rclone not found");

  process.env.RCLONE_CONFIG_R2_TYPE = "s3";
  process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";
  process.env.RCLONE_CONFIG_R2_ACCESS_KEY_ID = r2Key;
  process.env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = r2Secret;
  process.env.RCLONE_CONFIG_R2_ENDPOINT = endpoint;

  // "<size>;<name>" per line (--format sp) so we get the object SIZE too — a fresh-but-empty object
  // must not read as healthy. Sort by name (lexical = chronological) to pick the newest.
  const ls = capture("rclone", [
    "lsf",
    "--files-only",
    "--format",
    "sp",
    "--separator",
    ";",
    `r2:${r2Bucket}/${backupPrefix}/2hourly/`,
    "--s3-no-check-bucket",
  ]);
  const entries = ls.out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(";");
      return i < 0 ? { size: NaN, name: line } : { size: Number(line.slice(0, i)), name: line.slice(i + 1) };
    })
    .filter((e) => e.name)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const newestEntry = entries.length ? entries[entries.length - 1] : null;
  const newest = newestEntry?.name ?? "";
  if (!newest) await fail(`no objects under ${backupPrefix}/2hourly/`);

  // Size gate (#7): a fresh-but-truncated/empty object is BROKEN, not a missed tick — page directly
  // (never self-heal, which would just re-trigger a backup that may keep producing a bad object).
  if (newestEntry && Number.isFinite(newestEntry.size) && newestEntry.size < minBytes) {
    await fail(`newest object ${newest} is ${newestEntry.size} bytes (< dump.min-bytes ${minBytes}) — truncated/empty, not just stale`);
  }

  // Filename: <name>-YYYYMMDDTHHMMSSZ.<ext> → extract the stamp.
  const prefix = `${fileBasename}-`;
  let s = newest.startsWith(prefix) ? newest.slice(prefix.length) : newest;
  s = s.split(".")[0];
  if (s.length < 16) await fail(`cannot parse timestamp from '${newest}'`);

  // The stamp is always UTC (the backup writes `date -u`). Parse via Date.UTC — never Date.parse of a
  // naive string, which would use the local TZ and shift the age. DISPLAY_TZ affects only the row.
  const epochMs = stampToEpochMs(s);
  if (Number.isNaN(epochMs)) await fail(`cannot interpret timestamp '${s}' from '${newest}'`);

  const nowMs = Date.now();
  const ageH = Math.floor((nowMs - epochMs) / 3_600_000); // integer-truncated, like the bash
  const ageM = Math.floor((nowMs - epochMs) / 60_000);

  // Refresh today's Slack row every run (independent of freshness): re-renders ⬜ placeholders for
  // elapsed-but-empty 2-hourly buckets. No-op when today has no message yet.
  await slackDailyRefresh().catch(() => {});

  // Slot-based freshness: did THIS cadence slot's backup land? A missed slot is caught ~grace minutes
  // past its boundary, so recovery tracks the grace window — not the (necessarily large) max-age
  // backstop, which a healthy 2-hourly system reaches by design. maxAgeHours is retained as a backstop:
  // if slot-minutes is misconfigured (or the slot math drifts), a truly ancient object still pages.
  const { overdue, slotStartMs } = slotState(nowMs, epochMs, slotMinutes, graceMinutes);
  const slotIso = new Date(slotStartMs).toISOString();
  console.log(
    `Newest 2hourly object: ${newest} — ${ageH}h ${ageM}m old ` +
      `(slot ${slotIso}, grace ${graceMinutes}m, backstop ${staleHours}h)`,
  );
  if (!overdue && ageH < staleHours) {
    console.log(`✓ Fresh: newest backup is ${ageM}m old; current slot (${slotIso}) satisfied`);
    return;
  }
  await onStale(
    overdue
      ? `slot ${slotIso} backup is overdue (>${graceMinutes}m past the boundary; newest ${newest} is ${ageM}m old)`
      : `newest backup ${newest} is ${ageH}h old (> ${staleHours}h backstop)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
