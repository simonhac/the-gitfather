import "./lib/bootEnv.js"; // MUST be first — loads $PROFILE before backupTypes reads DISPLAY_TZ
// ─────────────────────────────────────────────────────────────────────────────
// doctor — the "is this consumer well configured?" preflight.
//
//   npx tsx scripts/doctor.ts <backup|drill|staleness|dashboard|all>
//   npm run doctor -- all
//
// For each selected task it: (1) runs the SAME zod schema the task itself uses
// (lib/config.ts) — so config validation and the preflight can never drift — then
// (2) runs only that task's read-only client probes (lib/preflight.ts) and prints a
// ✓/⚠/✗ checklist. Exit 0 iff every REQUIRED check passes, else 1.
//
// STRICTLY READ-ONLY: no dump, no upload, no `gh workflow run`, no Slack post. Safe to
// run against production credentials. This is the broader preflight that complements
// build-dashboard's `--sample` and check-staleness's `DRY_RUN`.
// ─────────────────────────────────────────────────────────────────────────────

import { loadBackupConfig, loadDrillConfig, loadStalenessConfig, loadDashboardConfig } from "./lib/config.js";
import {
  type ProbeResult,
  checkBinary,
  checkPgClientVersion,
  checkR2,
  checkPostgres,
  checkSlack,
  checkGh,
  configureRcloneRemote,
} from "./lib/preflight.js";

const TASKS = ["backup", "drill", "staleness", "dashboard"] as const;
type Task = (typeof TASKS)[number];

async function probeBackup(): Promise<ProbeResult[]> {
  const cfg = loadBackupConfig();
  const out: ProbeResult[] = [checkBinary("rclone"), checkBinary("pg_dump")];
  if (cfg.ENCRYPTION === "age") out.push(checkBinary("age"));
  if (cfg.PG_CLIENT_MAJOR) out.push(checkPgClientVersion(cfg.PG_CLIENT_MAJOR, "pg_dump"));
  configureRcloneRemote("r2", cfg.R2_ACCOUNT_ID, cfg.R2_ACCESS_KEY_ID, cfg.R2_SECRET_ACCESS_KEY);
  out.push(checkR2("r2", cfg.R2_BUCKET, "R2 dump bucket"));
  out.push(checkPostgres(cfg.PG_BACKUP_DATABASE_URL, "backup source"));
  if (cfg.SLACK_BOT_TOKEN && cfg.SLACK_CHANNEL) out.push(await checkSlack(cfg.SLACK_BOT_TOKEN, cfg.SLACK_CHANNEL));
  return out;
}

async function probeDrill(): Promise<ProbeResult[]> {
  const cfg = loadDrillConfig();
  const out: ProbeResult[] = [checkBinary("rclone"), checkBinary("pg_restore"), checkBinary("psql")];
  if (cfg.ENCRYPTION === "age") out.push(checkBinary("age"));
  if (cfg.PG_CLIENT_MAJOR) out.push(checkPgClientVersion(cfg.PG_CLIENT_MAJOR, "pg_restore"));
  configureRcloneRemote("r2", cfg.R2_ACCOUNT_ID, cfg.R2_ACCESS_KEY_ID, cfg.R2_SECRET_ACCESS_KEY);
  out.push(checkR2("r2", cfg.R2_BUCKET, "R2 dump bucket"));
  out.push(checkPostgres(cfg.DRILL_DATABASE_URL, "drill target"));
  out.push(checkPostgres(cfg.PG_LIVE_DATABASE_URL, "live row-count source"));
  if (cfg.SLACK_BOT_TOKEN && cfg.SLACK_CHANNEL) out.push(await checkSlack(cfg.SLACK_BOT_TOKEN, cfg.SLACK_CHANNEL));
  return out;
}

async function probeStaleness(): Promise<ProbeResult[]> {
  const cfg = loadStalenessConfig();
  const out: ProbeResult[] = [checkBinary("rclone")];
  configureRcloneRemote("r2", cfg.R2_ACCOUNT_ID, cfg.R2_ACCESS_KEY_ID, cfg.R2_SECRET_ACCESS_KEY);
  out.push(checkR2("r2", cfg.R2_BUCKET, "R2 dump bucket"));
  if (cfg.SELF_HEAL) out.push(checkGh(process.env.GITHUB_REPOSITORY));
  if (cfg.SLACK_BOT_TOKEN && cfg.SLACK_CHANNEL) out.push(await checkSlack(cfg.SLACK_BOT_TOKEN, cfg.SLACK_CHANNEL));
  return out;
}

async function probeDashboard(): Promise<ProbeResult[]> {
  // Validate the real (R2-reading) path; --upload's bucket is probed below if its creds are present.
  const cfg = loadDashboardConfig({ fromR2: true });
  const out: ProbeResult[] = [checkBinary("rclone")];

  // Private dump bucket (reads the rich logs). Credentials are the env's R2_* (not part of the
  // dashboard grammar) — doctor reads them directly so it can set up the rclone remote.
  const acct = process.env.R2_ACCOUNT_ID;
  const key = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (cfg.R2_BUCKET && acct && key && secret) {
    configureRcloneRemote("r2", acct, key, secret);
    out.push(checkR2("r2", cfg.R2_BUCKET, "R2 dump bucket (read logs)"));
  } else {
    out.push({
      name: "R2 dump bucket (read logs)",
      ok: false,
      detail: "set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY to probe",
    });
  }

  // Public dashboard bucket (write target) — list-only probe, never uploads. Only if --upload creds present.
  const dkey = process.env.DASHBOARD_R2_ACCESS_KEY_ID;
  const dsecret = process.env.DASHBOARD_R2_SECRET_ACCESS_KEY;
  if (cfg.DASHBOARD_R2_BUCKET) {
    if (acct && dkey && dsecret) {
      configureRcloneRemote("r2dash", acct, dkey, dsecret);
      out.push(checkR2("r2dash", cfg.DASHBOARD_R2_BUCKET, "R2 dashboard bucket"));
    } else {
      out.push({
        name: "R2 dashboard bucket",
        ok: false,
        detail: "set DASHBOARD_R2_ACCESS_KEY_ID / DASHBOARD_R2_SECRET_ACCESS_KEY to probe",
        optional: true,
      });
    }
  }
  return out;
}

const PROBES: Record<Task, () => Promise<ProbeResult[]>> = {
  backup: probeBackup,
  drill: probeDrill,
  staleness: probeStaleness,
  dashboard: probeDashboard,
};

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? "").toLowerCase();
  const valid = [...TASKS, "all"];
  if (!valid.includes(arg)) {
    process.stderr.write(`usage: tsx scripts/doctor.ts <${valid.join("|")}>\n`);
    process.exit(2);
  }
  const selected: Task[] = arg === "all" ? [...TASKS] : [arg as Task];

  let allOk = true;
  for (const task of selected) {
    console.log(`\n● doctor: ${task}`);
    // PROBES[task]() runs load*Config first; on a bad config it prints the aggregated report and
    // exits 1 before any probe — so reaching the loop below means the config validated.
    const results = await PROBES[task]();
    console.log(`  ✓ config — all variables present & valid`);
    for (const r of results) {
      const mark = r.ok ? "✓" : r.optional ? "⚠" : "✗";
      console.log(`  ${mark} ${r.name} — ${r.detail}`);
      if (!r.ok && !r.optional) allOk = false;
    }
  }

  console.log(allOk ? "\n✓ doctor: all required checks passed" : "\n✗ doctor: some required checks failed");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
