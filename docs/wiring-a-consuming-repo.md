# Wiring a consuming repo

> 💡 Want this done for you? [`setting-up-gitfather.md`](setting-up-gitfather.md) is an
> LLM-guided walkthrough of every step below.

## 1. Add your profile

Copy [`profiles/example.yaml`](../profiles/example.yaml) into your repo (e.g. `pg-backup/myproject.yaml`) and
edit it. It is **non-secret** — `name`, `backup-prefix`, dump flags, GFS anchor, `retention:` windows,
the restore-drill `row-count-table`, timezone, etc. See the
[profile reference](configuration-and-troubleshooting.md#profile-reference).

## 2. Add the caller workflows (`.github/workflows/` in your repo)

Five reusable workflows, each with a thin caller here. `pg-backup` and `pg-dashboard` are the core;
`pg-durable-verify` is strongly recommended (and supersedes `pg-restore-drill`); `pg-archive` is
optional. There is **no staleness caller**: the watchdog runs inside the
[Cloudflare Worker](../scheduler/README.md), which reads the `staleness:` block your backup publishes
to the bucket — so a repo with no Actions minutes left is still watched. The `# see "Job-log link"` comments below refer to
[Slack, the failure webhook, and the dead-man's-switch → Job-log link](slack-and-alerting.md#job-log-link).

> **Secrets must be passed explicitly.** This repo is **public and owned by `simonhac`**, so for any
> consumer in a *different* account/org, GitHub's `secrets: inherit` shortcut **does not work** (it
> only passes secrets to reusable workflows in the *same* org/enterprise). The examples below therefore
> pass each secret explicitly and thread the non-secret deployment identifiers (R2 bucket, Slack channel) as
> inputs — this works from any owner. All project *config* lives in the committed `profiles/*.yaml`. If your repo is in the same org as this one, you may use `secrets: inherit`.

`pg-backup.yml`:

```yaml
name: My DB backup → R2          # keep this name — pg-dashboard's workflow_run references it
on:
  schedule:
    - cron: "0 0,8,16 * * *"     # 00/08/16 UTC (8-hourly); the anchor-hour-utc (16) run also promotes
  workflow_dispatch:
    inputs:
      reason:
        description: "Why this run fired; the self-heal passes 'self-heal' (drives the Slack-row marker)."
        type: string
        default: manual
concurrency: { group: pg-backup, cancel-in-progress: false }
jobs:
  backup:
    permissions: { contents: read, actions: read }   # optional — precise job-log link in failure alerts; see "Job-log link"
    uses: simonhac/the-gitfather/.github/workflows/pg-backup.yml@main
    with:
      profile: pg-backup/myproject.yaml
      r2_bucket: ${{ vars.R2_BUCKET }}
      slack_channel: ${{ vars.SLACK_CHANNEL }}
      trigger: ${{ github.event_name == 'schedule' && 'schedule' || github.event.inputs.reason }}
    secrets:
      PG_BACKUP_DATABASE_URL: ${{ secrets.PG_BACKUP_DATABASE_URL }}
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}   # optional
      HEARTBEAT_URL: ${{ secrets.HEARTBEAT_URL }}       # optional
      ALERT_WEBHOOK_URL: ${{ secrets.ALERT_WEBHOOK_URL }}   # optional failure webhook (no-bot fallback / redundant channel)
```

`pg-restore-drill.yml`:

```yaml
name: My DB restore drill
on:
  schedule:
    - cron: "37 17 * * 1"        # Mondays 17:37 UTC
  workflow_dispatch: {}
concurrency: { group: pg-restore-drill, cancel-in-progress: false }
jobs:
  drill:
    permissions: { contents: read, actions: read }   # optional — precise job-log link in failure alerts; see "Job-log link"
    uses: simonhac/the-gitfather/.github/workflows/pg-restore-drill.yml@main
    with:
      profile: pg-backup/myproject.yaml
      r2_bucket: ${{ vars.R2_BUCKET }}
      slack_channel: ${{ vars.SLACK_CHANNEL }}
    secrets:
      PG_BACKUP_DATABASE_URL: ${{ secrets.PG_BACKUP_DATABASE_URL }}
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}   # optional
      ALERT_WEBHOOK_URL: ${{ secrets.ALERT_WEBHOOK_URL }}   # optional failure webhook
```

`pg-durable-verify.yml` (runs **daily**) — guarantees *every* durable file is integrity-tested, not just
the newest. Its **primary** leg hash-checks each new daily/weekly/monthly object against the SHA-256 recorded
at backup time and full-restores the freshest `daily`; its **secondary** leg re-restores the newest
weekly/monthly object ≥ `verify-durable.retest-days` (14) old not yet restore-verified. Net: weekly/monthly
are validated twice (hash on write + restore at ~2 weeks), daily once. Because the daily primary restore covers
the freshest dump more often than the weekly drill, this **supersedes `pg-restore-drill.yml`** — wire this one
and drop the weekly drill (or keep both). Cadence/limits are profile knobs (`verify-durable.fresh`,
`verify-durable.aged`, `verify-durable.retest-days`, `verify-durable.max-restores`).

```yaml
name: My DB durable verify
on:
  schedule:
    - cron: "37 18 * * *"        # daily, after the anchor-hour backup
  workflow_dispatch: {}
concurrency: { group: pg-durable-verify, cancel-in-progress: false }
jobs:
  verify:
    permissions: { contents: read, actions: read }   # optional — precise job-log link in failure alerts; see "Job-log link"
    uses: simonhac/the-gitfather/.github/workflows/pg-durable-verify.yml@main
    with:
      profile: pg-backup/myproject.yaml
      r2_bucket: ${{ vars.R2_BUCKET }}
      slack_channel: ${{ vars.SLACK_CHANNEL }}
    secrets:
      PG_BACKUP_DATABASE_URL: ${{ secrets.PG_BACKUP_DATABASE_URL }}
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}   # optional
      AGE_IDENTITY: ${{ secrets.AGE_IDENTITY }}   # only if backups are .age-encrypted
      ALERT_WEBHOOK_URL: ${{ secrets.ALERT_WEBHOOK_URL }}   # optional failure webhook
      VERIFY_HEARTBEAT_URL: ${{ secrets.VERIFY_HEARTBEAT_URL }}   # optional push switch; omit it here and setting the secret does nothing
```

`pg-dashboard.yml` — runs after each backup, isolated so a dashboard failure never affects backups:

```yaml
name: My DB backup dashboard → R2
on:
  workflow_run:
    workflows: ["My DB backup → R2"]   # must match the backup caller's `name:`
    types: [completed]
  workflow_dispatch: {}
concurrency: { group: pg-dashboard, cancel-in-progress: true }
jobs:
  publish:
    uses: simonhac/the-gitfather/.github/workflows/pg-dashboard.yml@main
    with:
      profile: pg-backup/myproject.yaml
      r2_bucket: ${{ vars.R2_BUCKET }}
      dashboard_r2_bucket: ${{ vars.DASHBOARD_R2_BUCKET }}
    secrets:
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      DASHBOARD_R2_ACCESS_KEY_ID: ${{ secrets.DASHBOARD_R2_ACCESS_KEY_ID }}
      DASHBOARD_R2_SECRET_ACCESS_KEY: ${{ secrets.DASHBOARD_R2_SECRET_ACCESS_KEY }}
```

`pg-archive.yml` *(optional)* — only if your profile has an [`archive:`](archiving.md) block:

```yaml
name: My DB table archive → R2
on:
  schedule:
    - cron: "30 19 * * 0"        # Sundays 19:30 UTC — after the weekly promotion and durable-verify
  workflow_dispatch:
    inputs:
      mode:           { type: choice, options: [both, archive, prune], default: both }
      table:          { type: string, default: "" }
      max_weeks:      { type: string, default: "" }
      dry_run:        { type: choice, options: [none, source, store], default: none }
      backfill_sizes: { type: boolean, default: false }
      backfill_apply: { type: boolean, default: false }
concurrency: { group: pg-archive, cancel-in-progress: false }
jobs:
  archive:
    permissions: { contents: read, actions: read }   # optional — precise job-log link; see "Job-log link"
    uses: simonhac/the-gitfather/.github/workflows/pg-archive.yml@main
    with:
      profile: pg-backup/myproject.yaml
      r2_bucket: ${{ vars.R2_BUCKET }}
      slack_channel: ${{ vars.SLACK_CHANNEL }}
      mode: ${{ inputs.mode || 'both' }}
      table: ${{ inputs.table || '' }}
      max_weeks: ${{ inputs.max_weeks || '' }}
      dry_run: ${{ inputs.dry_run || 'none' }}
      backfill_sizes: ${{ inputs.backfill_sizes || false }}
      backfill_apply: ${{ inputs.backfill_apply || false }}
    secrets:
      PG_ARCHIVE_DATABASE_URL: ${{ secrets.PG_ARCHIVE_DATABASE_URL }}
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      AGE_ARCHIVE_RECIPIENT: ${{ secrets.AGE_ARCHIVE_RECIPIENT }}   # only if archive.encryption: age
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}   # optional
      ALERT_WEBHOOK_URL: ${{ secrets.ALERT_WEBHOOK_URL }}   # optional failure webhook
```

> **Give every input a default.** The Cloudflare scheduler dispatches `archive` with **no inputs at
> all**, so any input without a default would break a Worker-driven run. If you use the scheduler,
> delete the `schedule:` block above and add `"archive"` to that client's roster `cadences` — `archive`
> is the one **opt-in** cadence, so an omitted `cadences` list does *not* include it. See
> [`scheduler/README.md`](../scheduler/README.md).

> **Pinning.** `@main` always runs the latest. To pin a release, tag this repo (e.g. `v1`) and use
> `…@v1` **and** add `gitfather_ref: v1` to each `with:` so the scripts checkout matches the workflow.

## 3. Set the secrets / variables (in your repo)

The caller reads these and passes them in (explicit `secrets:` + `with:` inputs, as above).

| Kind | Name | Value |
|---|---|---|
| secret | `PG_BACKUP_DATABASE_URL` | `postgres://…:5432/…?sslmode=require` (master DB URL; **never** commit/log) |
| secret | `R2_ACCOUNT_ID` | Cloudflare account id |
| secret | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | scoped R2 S3 token (Object Read & Write, **no delete**) |
| **variable** | `R2_BUCKET` | private dump bucket name |
| secret | `SLACK_BOT_TOKEN` | (optional) `xoxb-…`, scope `chat:write` |
| **variable** | `SLACK_CHANNEL` | (optional) channel id `C…` — the non-secret id paired with the bot token. May instead live in the profile as `slack.channel`; the variable wins when both are set |
| secret | `HEARTBEAT_URL` | (optional) dead-man's-switch ping URL — the backup |
| secret | `VERIFY_HEARTBEAT_URL` | (optional) push dead-man's-switch for durable-verify — pinged only on a clean verify. The scheduler's `/health/jobs` already covers this with no secret (see [slack-and-alerting.md](slack-and-alerting.md#job-proofs-one-monitor-for-every-job)) |
| secret | `ALERT_WEBHOOK_URL` | (optional) generic **failure** webhook (Slack-compatible `{"text":…}` POST) — a no-bot alert fallback, or a redundant failure channel into a host app's existing incoming webhook when the bot is also set |
| secret | `AGE_RECIPIENT` / `AGE_IDENTITY` | (optional) only when `encryption: age` |
| secret | `PG_ARCHIVE_DATABASE_URL` | (archive) the same DB, kept separate because this is the only task that **deletes** |
| secret | `AGE_ARCHIVE_RECIPIENT` | (archive) age **public** recipient. Its identity stays OFFLINE — never a repo secret |
| **variable** | `DASHBOARD_R2_BUCKET` | (dashboard) public bucket name |
| secret | `DASHBOARD_R2_ACCESS_KEY_ID` / `DASHBOARD_R2_SECRET_ACCESS_KEY` | (dashboard) write-only token for the public bucket |

> Pushing workflow files needs a token with the `workflow` scope.

> **What you do *not* set:** `DRILL_DATABASE_URL` and `PG_LIVE_DATABASE_URL`. The reusable drill and
> durable-verify workflows provide those themselves — the restore target is a throwaway Postgres
> service container inside the job, and the live comparison uses `PG_BACKUP_DATABASE_URL`. You only
> ever export them by hand when running `npm run doctor -- drill` locally.
