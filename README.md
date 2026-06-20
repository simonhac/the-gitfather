# the-gitfather

> Off-site, **G**randfather-**F**ather-**S**on retained, monitored, restore-verified Postgres backups —
> driven by GitHub Actions, stored on Cloudflare R2.

A small, **profile-driven** tool any project can adopt: point it at a Postgres connection string and an
R2 bucket and you get the **off-site, immutable, restore-verified** pillars of the **3-2-1-1-0** backup
pattern (the *1-1-0*) — plus one independent off-site copy toward the *3-2* — with a daily Slack status
row and a static backup-history dashboard. The engine knows nothing about any one project; everything
project-specific lives in a `profiles/*.env` file kept in *your* repo, and credentials come from the
environment (GitHub secrets), never from the repo. See [Where this fits: 3-2-1-1-0](#where-this-fits-3-2-1-1-0).

```
the-gitfather/
  scripts/
    backup-pg-to-r2.sh    # dump → (encrypt) → upload 2hourly/ → promote to daily/weekly/monthly
    restore-drill-pg.sh   # pull newest → restore into a throwaway → assert row counts
    check-staleness.sh    # alert if no fresh backup landed recently; self-heal a missed tick
    build-dashboard.ts    # render the static backup-history dashboard from the R2 run-logs
    runlog.ts             # append-only run/verification log in R2 (the dashboard's source of truth)
    lib/{slack.sh, backupTypes.ts, backupHistory.ts}
  dashboard/              # single-file static dashboard (template + SVG heatmap renderer)
  profiles/example.env    # copy this into YOUR repo and edit
  .github/
    workflows/            # REUSABLE (on: workflow_call): pg-backup, pg-restore-drill,
                          #   pg-staleness-check, pg-dashboard
    actions/setup-tools   # composite: pinned rclone + jq (+ optional pg client)
```

Built as a GitHub-Actions toolkit, but every script is runnable locally for testing.

---

## Where this fits: 3-2-1-1-0

**3-2-1-1-0** is the hardened evolution of the classic 3-2-1 backup rule:

| Digit | Rule | What it's for |
|---|---|---|
| **3** | ≥3 copies of the data | One primary + two backups, so no single loss is fatal |
| **2** | on ≥2 different media | Different *failure domains* — a flaw that kills one medium doesn't kill both |
| **1** | ≥1 copy off-site | Survives a site-level disaster (fire, theft, region outage) |
| **1** | ≥1 copy immutable / offline | Survives ransomware or a leaked/malicious credential that tries to delete backups |
| **0** | **0** recovery-verification errors | A backup you've never restored is a hope, not a backup — prove it restores |

The last two digits are what most setups skip, and they're exactly where this tool is strong. Here's
the honest mapping of what the-gitfather delivers:

| Digit | Coverage | How |
|---|---|---|
| **3** copies | ⚠️ partial | Manages **one** backup destination (a single R2 bucket). The GFS tiers are point-in-time *versions of the same dump in the same bucket* — more restore points, not independent copies. Your production DB is copy #1 (the source, not the tool's job); R2 is copy #2; a 3rd copy is on you. |
| **2** media | ❌ not provided | Every copy the tool writes lives on one medium / provider / failure domain (R2). "2 media" only exists incidentally because your prod DB lives elsewhere. |
| **1** off-site | ✅ delivered | Dumps go to Cloudflare R2 — a different provider and location from your Postgres host. |
| **1** immutable | ✅ delivered* | R2 bucket locks (WORM) + a no-delete CI token make the durable tiers immutable for 14 days against the primary threat (a leaked CI key). *It's immutable, not air-gapped — a full account takeover can strip the locks. See [Threat model](#threat-model). |
| **0** errors | ✅ delivered | `restore-drill-pg.sh` restores the newest dump into a throwaway DB and asserts row counts, backed by the staleness check, Slack status, and an external dead-man's switch. |

**Net:** the tool nails the back half (**1-1-0**) and supplies **one off-site copy** toward the front
half — it does not by itself give you 3 independent copies on 2 distinct media. To earn the full
**3-2-1-1-0**, add a second, independent backup leg on a different medium / failure domain (e.g. a
periodic `pg_dump` to local disk/NAS, or replicate the R2 bucket to another provider or region). The
dump this tool already produces is the natural feed for it.

---

## How it fits together

The reusable workflows live here; **each consuming repo keeps a thin caller workflow** that owns the
cron schedule + secrets and passes the path to its own profile. Because this repo is public, the
reusable workflows check out their own script code with no token. Because the profile lives in the
*caller* repo, each reusable workflow checks out two things: the caller repo (for the profile) and this
repo (for the scripts).

```
your-repo                              the-gitfather (this repo, public)
  pg-backup/myproject.env   ─────►     scripts/ + dashboard/
  .github/workflows/                   .github/workflows/  (reusable)
    pg-backup.yml ───────────uses────────►  pg-backup.yml
    pg-restore-drill.yml ────uses────────►  pg-restore-drill.yml
    pg-staleness-check.yml ──uses────────►  pg-staleness-check.yml
    pg-dashboard.yml ────────uses────────►  pg-dashboard.yml
```

---

## Wiring a consuming repo

### 1. Add your profile

Copy [`profiles/example.env`](profiles/example.env) into your repo (e.g. `pg-backup/myproject.env`) and
edit it. It is **non-secret** — `BACKUP_PREFIX`, `FILE_BASENAME`, dump flags, GFS anchor, restore-drill
sentinel table, Slack display tz, etc. See **Profile reference** below.

### 2. Add the caller workflows (`.github/workflows/` in your repo)

> **Secrets must be passed explicitly.** This repo is **public and owned by `simonhac`**, so for any
> consumer in a *different* account/org, GitHub's `secrets: inherit` shortcut **does not work** (it
> only passes secrets to reusable workflows in the *same* org/enterprise). The examples below therefore
> pass each secret explicitly and thread non-secret config (bucket names, Slack channel) as inputs —
> this works from any owner. If your repo happens to be in the same org as this one, you may use
> `secrets: inherit` instead of the explicit `secrets:` block.

`pg-backup.yml`:

```yaml
name: My DB backup → R2          # keep this name — pg-dashboard's workflow_run references it
on:
  schedule:
    - cron: "0 */2 * * *"        # every 2 hours (UTC); the ANCHOR_HOUR_UTC run also promotes
  workflow_dispatch: {}
concurrency: { group: pg-backup, cancel-in-progress: false }
jobs:
  backup:
    uses: simonhac/the-gitfather/.github/workflows/pg-backup.yml@main
    with:
      profile: pg-backup/myproject.env
      r2_bucket: ${{ vars.R2_BUCKET }}
      slack_channel: ${{ vars.SLACK_CHANNEL }}
    secrets:
      PG_BACKUP_DATABASE_URL: ${{ secrets.PG_BACKUP_DATABASE_URL }}
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}   # optional
      HEARTBEAT_URL: ${{ secrets.HEARTBEAT_URL }}       # optional
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
    uses: simonhac/the-gitfather/.github/workflows/pg-restore-drill.yml@main
    with:
      profile: pg-backup/myproject.env
      r2_bucket: ${{ vars.R2_BUCKET }}
      slack_channel: ${{ vars.SLACK_CHANNEL }}
    secrets:
      PG_BACKUP_DATABASE_URL: ${{ secrets.PG_BACKUP_DATABASE_URL }}
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}   # optional
```

`pg-staleness-check.yml` — note the `permissions` block (the self-heal re-triggers your backup workflow):

```yaml
name: My DB staleness check
on:
  schedule:
    - cron: "20 * * * *"         # hourly, off the top of the hour
  workflow_dispatch: {}
concurrency: { group: pg-staleness-check, cancel-in-progress: false }
jobs:
  check:
    permissions:
      actions: write             # lets the self-heal call `gh workflow run pg-backup.yml`
      contents: read
    uses: simonhac/the-gitfather/.github/workflows/pg-staleness-check.yml@main
    with:
      profile: pg-backup/myproject.env
      backup_workflow: pg-backup.yml   # your backup workflow's file name
      r2_bucket: ${{ vars.R2_BUCKET }}
      slack_channel: ${{ vars.SLACK_CHANNEL }}
    secrets:
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}   # optional
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
      profile: pg-backup/myproject.env
      r2_bucket: ${{ vars.R2_BUCKET }}
      dashboard_r2_bucket: ${{ vars.DASHBOARD_R2_BUCKET }}
    secrets:
      R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      DASHBOARD_R2_ACCESS_KEY_ID: ${{ secrets.DASHBOARD_R2_ACCESS_KEY_ID }}
      DASHBOARD_R2_SECRET_ACCESS_KEY: ${{ secrets.DASHBOARD_R2_SECRET_ACCESS_KEY }}
```

> **Pinning.** `@main` always runs the latest. To pin a release, tag this repo (e.g. `v1`) and use
> `…@v1` **and** add `gitfather_ref: v1` to each `with:` so the scripts checkout matches the workflow.

### 3. Set the secrets / variables (in your repo)

The caller reads these and passes them in (explicit `secrets:` + `with:` inputs, as above).

| Kind | Name | Value |
|---|---|---|
| secret | `PG_BACKUP_DATABASE_URL` | `postgres://…:5432/…?sslmode=require` (master DB URL; **never** commit/log) |
| secret | `R2_ACCOUNT_ID` | Cloudflare account id |
| secret | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | scoped R2 S3 token (Object Read & Write, **no delete**) |
| **variable** | `R2_BUCKET` | private dump bucket name |
| secret | `SLACK_BOT_TOKEN` | (optional) `xoxb-…`, scope `chat:write` |
| **variable** | `SLACK_CHANNEL` | (optional) channel id `C…` |
| secret | `HEARTBEAT_URL` | (optional) dead-man's-switch ping URL |
| secret | `AGE_RECIPIENT` / `AGE_IDENTITY` | (optional) only when `ENCRYPTION=age` |
| **variable** | `DASHBOARD_R2_BUCKET` | (dashboard) public bucket name |
| secret | `DASHBOARD_R2_ACCESS_KEY_ID` / `DASHBOARD_R2_SECRET_ACCESS_KEY` | (dashboard) write-only token for the public bucket |

> Pushing workflow files needs a token with the `workflow` scope.

---

## Backup tiers (GFS + a finer "grandson" tier)

| Tier | Label | Cadence | R2 prefix | Lifecycle expiry | Bucket lock |
|---|---|---|---|---|---|
| 2-hourly | grandson | every 2 h | `<prefix>/2hourly/` | 2 days | none |
| daily | Son | anchor hour | `<prefix>/daily/` | 21 days | 14 days |
| weekly | Father | Sundays @ anchor | `<prefix>/weekly/` | 70 days | 14 days |
| monthly | Grandfather | 1st @ anchor | `<prefix>/monthly/` | 400 days | 14 days |

**One dump, promoted to all qualifying tiers.** Each run dumps once and uploads to `2hourly/`. The run
whose UTC hour equals `ANCHOR_HOUR_UTC` is also **server-side copied** (R2→R2, no re-dump) into `daily/`,
plus `weekly/` on Sundays, plus `monthly/` on the 1st. Retention and immutability are enforced by **R2
lifecycle rules + bucket locks per prefix**, not by code.

### Create the R2 bucket, lifecycle rules, and bucket locks (once)

Run with **account-level** Cloudflare creds (this credential is the one that can weaken locks — **never**
give it to CI). Replace `<your-bucket>` and `<prefix>` (your profile's `BACKUP_PREFIX`).

```bash
npx wrangler r2 bucket create <your-bucket>

# Lifecycle: expire each tier on its own schedule
npx wrangler r2 bucket lifecycle add <your-bucket> expire-2hourly <prefix>/2hourly/ --expire-days 2
npx wrangler r2 bucket lifecycle add <your-bucket> expire-daily   <prefix>/daily/   --expire-days 21
npx wrangler r2 bucket lifecycle add <your-bucket> expire-weekly  <prefix>/weekly/  --expire-days 70
npx wrangler r2 bucket lifecycle add <your-bucket> expire-monthly <prefix>/monthly/ --expire-days 400
npx wrangler r2 bucket lifecycle add <your-bucket> abort-mpu      <prefix>/         --abort-multipart-days 1
npx wrangler r2 bucket lifecycle add <your-bucket> expire-status  _status/          --expire-days 14
npx wrangler r2 bucket lifecycle add <your-bucket> expire-log     _log/             --expire-days 460

# Bucket locks (WORM): 14-day immutability on the DURABLE tiers only — NOT on 2hourly/ (a lock there
# would block its 2-day expiry, since locks take precedence over lifecycle).
npx wrangler r2 bucket lock add <your-bucket> lock-daily   <prefix>/daily/   --retention-days 14
npx wrangler r2 bucket lock add <your-bucket> lock-weekly  <prefix>/weekly/  --retention-days 14
npx wrangler r2 bucket lock add <your-bucket> lock-monthly <prefix>/monthly/ --retention-days 14
```

Then mint a **scoped R2 S3 API token** for CI: Object **Read & Write**, **no delete**, scoped to this
bucket. That token cannot delete locked objects, overwrite them (keys are unique), or change
lock/lifecycle config — it is the only R2 credential CI gets.

For the dashboard, create a **separate public** bucket and a **write-only** token for it (the dump
bucket gains no web surface).

---

## Slack (optional)

Instead of one message per run (spam), the backup keeps **one message per day** and **updates it in
place** — a `✅`/`❌` + `HH:MM` tick per 2-hourly run, in `DISPLAY_TZ`. A failed run appends `❌` and
posts a loud, `@here`-mentioning threaded alert. Any **elapsed-but-empty** 2-hourly bucket renders as
`⬜ HH:00`, so a skipped run shows as a visible gap; the hourly staleness check re-renders the row so a
just-missed slot surfaces within the hour. This needs a **bot token** (`chat.update`; incoming webhooks
can't update). "Today's message" is persisted as a tiny JSON object at `_status/<basename>/<date>.json`
in R2. If `SLACK_BOT_TOKEN`/`SLACK_CHANNEL` are unset, all Slack output is silently skipped.

Setup: create a Slack app → **Bot Token Scopes**: `chat:write` → install → copy the `xoxb-…` token →
**invite the bot to the channel** (`/invite @your-app`) → set `SLACK_BOT_TOKEN` + `SLACK_CHANNEL`.

### Dead-man's-switch (optional, recommended)

The only watchdog that runs *outside* GitHub, so it catches the scheduled workflow **not firing at all**
(Actions cron is best-effort). Create a check (e.g. [healthchecks.io](https://healthchecks.io)) with a
period of ~2 h + grace ~3 h, wire its Slack/email, and put its ping URL in `HEARTBEAT_URL`. The backup
pings it on success; its absence pages independently of GitHub.

---

## Backup-history dashboard

A static, self-contained page visualises **every 2-hourly run over the 400-day window** as a heatmap
(green = healthy & retained, brighter green = restore-verified, grey = aged out of retention, red =
failed, blank = no run). It reads an **append-only run-log in R2** (no server, no DB) that the backup +
drill scripts write via `runlog.ts`:

```
_log/<basename>/runs-YYYY-MM.jsonl           # {ts, ok, tiers, bytes, key, runId, runUrl, error}
_log/<basename>/verifications-YYYY-MM.jsonl   # {ts, verifiedTs, ok, ratio, runId, runUrl}
```

Monthly files roll over by name; an R2 lifecycle rule trims old months. `build-dashboard.ts` reads the
logs, **scrubs** them to a public payload (drops raw error text), `esbuild`-bundles the SVG renderer into
a single `index.html`, and uploads it to the **separate public** dashboard bucket.

> **Privacy.** The published page includes the project label + sizes + tiers + timestamps + verification
> ratio + run links; it **drops raw error text** (set `DASHBOARD_HIDE_RUN_LINKS=1` to also drop run
> links). The rich raw logs never leave the private bucket. To make the page itself private, front the
> public bucket with a custom domain + Cloudflare Access — no code change.

**Build locally:**

```bash
npm ci
npx tsx scripts/build-dashboard.ts --sample --out /tmp/dash/index.html   # sample data
# drop --sample + export the R2 env (+ DISPLAY_TZ) to render from real logs
```

---

## Running locally (before relying on CI)

```bash
export PG_BACKUP_DATABASE_URL='postgresql://…:5432/…?sslmode=require'
export R2_ACCOUNT_ID=… R2_BUCKET=<your-bucket> R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
export SLACK_BOT_TOKEN=xoxb-… SLACK_CHANNEL=C0…          # optional
# Run twice: the first posts the day's Slack message, the second UPDATES it with a 2nd tick.
FORCE_TIERS="2hourly daily" PROFILE=profiles/example.env bash scripts/backup-pg-to-r2.sh
```

Any local dump file lives under a tmp dir and is removed on exit — never commit a dump (it may contain
PII).

---

## Restoring for real (disaster recovery)

```bash
# 1. Pull the object you want (any tier) — needs the R2 creds + rclone configured as in the scripts.
rclone copyto "r2:<your-bucket>/<prefix>/daily/<basename>-<stamp>.dump" ./restore.dump

# 2. (If encrypted) age -d -i <identity> restore.dump.age > restore.dump

# 3. Restore into a fresh database
createdb restore_target
pg_restore --no-owner --no-privileges --disable-triggers -j4 -d restore_target restore.dump
```

`--disable-triggers` (target must be superuser) avoids FK ordering issues; provider-managed schemas may
warn in a vanilla Postgres — restore into a fresh instance of the same platform for a faithful recovery.

---

## Threat model

- **Leaked CI R2 key** (primary threat): scoped read+write, no delete → cannot delete/overwrite objects,
  cannot empty the bucket while locks exist, cannot touch lock/lifecycle config. The last 14 days of
  durable backups are immutable.
- **Leaked `PG_BACKUP_DATABASE_URL`**: the master DB credential and the highest-value secret here.
  Mitigations (a read-only role, ephemeral creds, server-side push) and at-rest encryption are the
  obvious next steps.
- **Full Cloudflare-account takeover**: can remove bucket locks (R2 has no COMPLIANCE "even-root-can't-
  delete" mode). Accepted for a DR / leaked-token model.
- **At rest**: with `ENCRYPTION=none`, dumps sit unencrypted in a **private** bucket (R2 still encrypts at
  rest). Set `ENCRYPTION=age` for client-side encryption if a full dump contains sensitive data.

---

## Profile reference

See [`profiles/example.env`](profiles/example.env): `BACKUP_PREFIX`, `FILE_BASENAME`, `PG_DUMP_FLAGS`,
`ENCRYPTION`, `PG_CLIENT_MAJOR`, `ANCHOR_HOUR_UTC`, `DRILL_SENTINEL_TABLE`, `DRILL_EXTRA_TABLES`,
`MIN_RATIO`, `MIN_BYTES`, `STALE_HOURS`, `DISPLAY_TZ`, `SLACK_ALERT_MENTION`, `DASHBOARD_LABEL`.

---

## Troubleshooting

### Every run fails instantly with `<VAR>: set <VAR>` (e.g. `PG_BACKUP_DATABASE_URL: set PG_BACKUP_DATABASE_URL`)

The secrets are arriving **empty** — the script aborts at its pre-flight env check. The usual cause is
using **`secrets: inherit`** in a caller that lives in a **different org/account** from this repo.

> `secrets: inherit` only passes secrets to a reusable workflow **in the same organization or
> enterprise**. This repo is public and owned by `simonhac`, so a consumer in any other org/account
> gets *nothing* from `inherit`, and every secret reads as empty.

**Fix:** pass each secret **explicitly** and thread non-secret config as inputs — see
[Wiring a consuming repo](#2-add-the-caller-workflows-githubworkflows-in-your-repo). Only use
`secrets: inherit` if your caller is in the **same org** as this repo.

A useful sanity check: if `vars.R2_BUCKET` etc. also read empty, the `vars` context isn't crossing the
owner boundary either — which is why the callers pass bucket/channel names as inputs rather than reading
`vars.*` inside the reusable workflow.

### Backups are failing but Slack shows nothing (only the dead-man's-switch paged)

This is expected, not a second bug. The Slack daily row is **in-band** — it's written *by the backup
script*, so it can only report failures the script reaches far enough to handle (a failed `pg_dump`,
a bad upload, a too-small dump). Failures *before* that point — empty secrets, a workflow that won't
start, a runner that dies, the cron not firing — never reach the Slack code, and the staleness check
(also in-band) can be knocked out by the same root cause. The **out-of-band dead-man's-switch**
(`HEARTBEAT_URL` → healthchecks.io etc.) is the catch-all for exactly these cases: it pages on the
*absence* of a success ping, independent of GitHub. Treat a healthchecks alarm with a quiet Slack row
as "the wiring/secrets/runner is broken," and check the Actions run logs.

### `Unrecognized named-value: 'vars'` when validating a workflow

You have a `${{ … }}` expression inside a `workflow_call` input `description:` — GitHub evaluates
expressions there, where `vars`/`secrets` aren't valid contexts. Use plain text in descriptions.
