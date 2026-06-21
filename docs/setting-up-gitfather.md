# Setting up the-gitfather — an LLM-guided walkthrough

**Audience: an AI coding agent.** This document tells *you* (the assistant) how to interview a
human operator, collect every value the backup engine needs, write it to the right places, and
finish by running `doctor` so the human gets a green ✓ checklist before they trust the system.

Do not dump this whole document at the user. Work through it as a conversation: ask in small
batches, record answers as you go, explain *how to obtain* each value the user doesn't already
know, and only move on once a section is complete.

---

## 0. The shape of the task

There are **two kinds of input**, and they live in **two different files**:

| Kind | What | Where it goes | Committed? |
|---|---|---|---|
| **Config** | project choices (prefix, basename, schedule, thresholds, tz…) | `profiles/<name>.yaml` | ✅ yes — checked into the consuming repo |
| **Credentials** | DB URLs, R2 keys, Slack token… | environment / GitHub Secrets; locally a **gitignored** file under `.context/` | ❌ **never** committed |

Your job is to produce three things, in order:

1. `.context/gitfather-setup.md` — the running interview record (what the user told you, decisions, open questions).
2. `profiles/<name>.yaml` — the committed config profile (copy of `profiles/example.yaml`, filled in).
3. `.context/gitfather-secrets.env` — a gitignored credentials file used **only** to run `doctor` locally. It mirrors what the user will later store as GitHub Secrets/Variables.

Then you run `npm run doctor -- all` with both files in scope and interpret the result.

> **Security guardrails — state these to the user and obey them:**
> - Never write a credential into `profiles/*.yaml` (it gets committed). Credentials go in `.context/gitfather-secrets.env` only.
> - `.context/` is gitignored, but still treat the secrets file as sensitive: don't echo full secret values back in chat, don't paste them into commit messages, don't `cat` it into shared logs.
> - Confirm `.context/gitfather-secrets.env` is gitignored before writing secrets to it (`git check-ignore .context/gitfather-secrets.env`).

---

## 1. Prerequisites (check before interviewing)

`doctor` will verify these, but flag missing ones early so the user can install them:

- `node` + `npm ci` already run (installs `tsx`, `zod`, `esbuild`).
- CLI tools on PATH: `rclone`, `pg_dump`, `pg_restore`, `psql`. Plus `age` **only if** they choose `encryption: age`, and `gh` **only if** staleness self-heal is on (the default).
- The Cloudflare R2 buckets already exist with lifecycle + lock rules applied. This is a **one-time manual step** done with account-level Cloudflare creds — see the README "Create the buckets" / wrangler section. The engine does **not** create buckets; `doctor` only probes that they're reachable.

If buckets don't exist yet, pause the setup and walk the user through the README's `wrangler r2 bucket create / lifecycle add / lock add` commands first.

---

## 2. Required information (the interview)

Ask for these. Group the questions; don't fire them one at a time. For each, the "How to get it"
column is what you tell a user who doesn't already know the value.

### 2a. Project identity (→ profile)

| Variable | Meaning | How to get it |
|---|---|---|
| `backup-prefix` | object-key prefix in R2, e.g. `pg/myapp` | user's choice; convention is `pg/<project>` |
| `name` | names dump files + Slack message + log paths, e.g. `myapp` | user's choice; short slug |

### 2b. Database (→ secrets)

| Variable | Meaning | How to get it |
|---|---|---|
| `PG_BACKUP_DATABASE_URL` | source DB to dump | `postgres://USER:PW@HOST:5432/DB?sslmode=require`. From the DB provider's connection-string panel. If the provider has a pooler, use the **session** pooler. |

For the **restore drill** (only if they want automated restore verification — recommended):

| Variable | Meaning | How to get it |
|---|---|---|
| `DRILL_DATABASE_URL` | a *throwaway* DB the drill restores into (gets wiped) | a separate empty database / instance |
| `PG_LIVE_DATABASE_URL` | live DB used only to read row counts for the ratio check | usually same as `PG_BACKUP_DATABASE_URL` |
| `drill.row-count-table` | `public.<table>` whose restored/live row ratio is asserted | the user's largest stable table |

### 2c. Cloudflare R2 — private dump bucket (→ secrets + one variable)

| Variable | Meaning | How to get it |
|---|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account id | Cloudflare dash → R2 → account id (a 32-hex string) |
| `R2_BUCKET` | the private dump bucket name | the bucket created in the prereq step |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | **scoped** S3 token: Object Read & Write, **no delete**, scoped to that bucket | Cloudflare dash → R2 → Manage API Tokens → create S3 token. This is an **S3 token**, *not* a Cloudflare API token. |

> Note the threat model: CI only ever gets this scoped, delete-less S3 token — never account-level Cloudflare creds.

---

## 3. Optional parameters

Everything here has a safe default or is feature-gated. Ask, but offer the default and move on.

### 3a. Schedule & sanity thresholds (→ profile, all have defaults)

| Variable | Default | Meaning |
|---|---|---|
| `anchor-hour-utc` | `16` | the UTC hour whose run is also promoted to daily/weekly/monthly tiers |
| `dump.min-bytes` | `1048576` (1 MB) | abort the upload if the dump is smaller (catches a truncated dump) |
| `staleness.max-age-hours` | `3` (example.yaml suggests `5`) | staleness alert if newest 2-hourly object is older than this |
| `drill.min-row-ratio` | `0.95` | restored/live row-count floor for the drill sentinel table |
| `drill.max-row-ratio` | `2.0` | restored/live row-count ceiling — catches duplicated/double-restored rows |
| `dump.flags` | `-Fc --no-owner --no-privileges` | pg_dump flags; tune per database (e.g. `--exclude-schema=…`) |
| `dump.client-major` | (unset) | if set, `doctor` checks your `pg_dump`/`pg_restore` major version ≥ this. Recommended — set it to your server's major version. |
| `drill.nonempty-tables` | (none) | space-separated tables asserted simply non-empty after restore |
| `drill.present-tables` | (none) | space-separated tables that must each **exist** and be non-empty after restore |
| `FORCE_TIERS` | (none) | for manual runs: space-separated subset of `2hourly daily weekly monthly` |

### 3b. Encryption (→ profile + secrets)

| Variable | Default | Meaning |
|---|---|---|
| `encryption` | `none` | `none` \| `age` \| `aes-gcm` (aes-gcm not implemented) |
| `AGE_RECIPIENT` | — | **required when `encryption: age`** (public key, `age1…`); used to encrypt |
| `AGE_IDENTITY` | — | **required when `encryption: age`** (private key); used by the drill + durable-verify to decrypt (and by the backup when `integrity.verify-after-upload`) |

### 3c. Slack status row (→ profile + secrets)

| Variable | Default | Meaning |
|---|---|---|
| `SLACK_BOT_TOKEN` | (unset → Slack off) | `xoxb-…`, scope `chat:write` (secret, env) |
| `SLACK_CHANNEL` | — | channel id `C…` (non-secret, env — a GitHub Variable). **Required if `SLACK_BOT_TOKEN` is set** (else the row silently never posts) |
| `slack.alert-mention` | `<!here>` | prepended to failure alerts (`<!here>` / `<!channel>`) — profile |
| `timezone` | `UTC` | IANA tz for the daily row's date + HH:MM labels (e.g. `Australia/Perth`) |
| `dashboard.url` | (unset) | if set, hyperlinks the Slack header's "`<basename> DB backup`" text to the dashboard. See note below on how to obtain it. |
| `ALERT_WEBHOOK_URL` | (unset) | optional **failure** webhook (secret), independent of the bot — a Slack-compatible `{"text":…}` POST on backup/drill/staleness failure. A no-bot alert fallback, or a redundant failure channel into a host app's existing incoming webhook. Fires on failure only (no success spam). |

### 3d. Public dashboard (→ profile + secrets)

| Variable | Default | Meaning |
|---|---|---|
| `dashboard.label` | `name` | project label shown on the public page |
| `dashboard.hide-run-links` | `false` | also drop run links from the public page |
| `DASHBOARD_R2_BUCKET` | — | the **separate public** bucket the built page is uploaded to (variable) |
| `DASHBOARD_R2_ACCESS_KEY_ID` / `DASHBOARD_R2_SECRET_ACCESS_KEY` | — | write-only S3 token for the public bucket (secrets) |

> **Getting `dashboard.url` — fetch it yourself, with permission.** The public hostname is an opaque
> `pub-<hash>.r2.dev` (or a custom domain) that is **not derivable** from the account id or bucket
> name, so don't make the user hunt for it — *you* retrieve it by running `wrangler` against the
> public bucket. That command uses the user's **account-level Cloudflare login** (a privileged
> credential), so **ask permission before running it**, e.g.:
>
> *"I can fetch the dashboard's public URL by running `npx wrangler r2 bucket dev-url get <bucket>` —
> this uses your Cloudflare login. OK to run it?"*
>
> On approval, run (fall back to the second form if they use a custom domain):
> - r2.dev managed URL: `npx wrangler r2 bucket dev-url get <DASHBOARD_R2_BUCKET>`
> - custom domain: `npx wrangler r2 bucket domain list <DASHBOARD_R2_BUCKET>`
>
> Parse the hostname from the output, confirm it back to the user, and write it to the profile. It's
> static for the life of the bucket, so this is a one-time fetch. If the user declines, leave
> `dashboard.url` unset (the header just renders unlinked) or let them paste it manually.

### 3e. Staleness behaviour (→ profile, defaults fine)

| Variable | Default | Meaning |
|---|---|---|
| `staleness.self-heal` | `true` | on a missed tick, re-trigger the backup workflow via `gh` (needs `gh` auth + `GITHUB_REPOSITORY`) |
| `staleness.dry-run` | `false` | staleness check evaluates but takes no action |
| `staleness.heal-workflow` | `pg-backup.yml` | workflow file self-heal triggers |
| `HEARTBEAT_URL` | (unset) | optional dead-man's-switch URL pinged on success (e.g. healthchecks.io) |

> `dump.min-bytes` is **also** the staleness floor: a fresh-but-smaller newest object is treated as broken
> (pages directly) rather than just stale.

### 3f. Backup integrity & durable verification (→ profile, defaults fine)

All default-on and safe — surface them only if the user asks *"how do you know the backups are good?"*

| Variable | Default | Meaning |
|---|---|---|
| `integrity.checksum` | `1` | record a SHA-256 of each uploaded object (the durable hash-verify baseline) |
| `integrity.check-structure` | `1` | `pg_restore -l` TOC check before declaring a backup good (`encryption: none`) |
| `integrity.verify-after-upload` | `0` | opt-in: re-download + (decrypt) + `pg_restore -l` after upload; the only **backup-time** structural check for age (needs `AGE_IDENTITY` in the backup job) |
| `verify-durable.fresh` | `1` | daily verify: hash-check each new durable object + restore the freshest `daily` |
| `verify-durable.aged` | `1` | daily verify: restore the newest `weekly`/`monthly` ≥ `verify-durable.retest-days` old not yet restore-verified |
| `verify-durable.retest-days` | `14` | age at which a weekly/monthly becomes secondary-due (set `13` to re-test inside the 14-day WORM lock) |
| `verify-durable.max-restores` | `2` | cap on full restores per daily verify run (hash-checks uncapped) |
| `drill.max-row-drop` | `0` (off) | if set (0–1), fail a drill when a table shrank more than this fraction vs the prior passing drill |

These power `verify-durable-pg.ts` (the daily `pg-durable-verify.yml` workflow), which guarantees every
durable file is tested — **weekly/monthly twice, daily once**. See README → **Verifying backups**.

---

## 4. Write the files

### 4a. Interview record — `.context/gitfather-setup.md`

Keep a living markdown record as you interview: every value provided (redact secret values to a
placeholder like `‹set›`), every default accepted, and any TODOs (e.g. "bucket not created yet").
This is your scratchpad and the user's audit trail.

### 4b. Profile — `profiles/<name>.yaml`

Start from `profiles/example.yaml` and fill in the **config** values only — a single nested **YAML**
file (kebab-case keys; e.g. `retention.father`, `dump.client-major`). **No credentials here** — those come
from the environment (the local secrets file below, or GitHub Secrets in CI). Leave optional keys at
their defaults unless the user chose otherwise.

### 4c. Local secrets — `.context/gitfather-secrets.env`

Same `KEY="value"` format, holding the **credentials** for the local `doctor` run. Include only what
applies to the tasks you'll check. Template:

```sh
# .context/gitfather-secrets.env — GITIGNORED, never commit. Local doctor run only.
PG_BACKUP_DATABASE_URL="postgres://…:5432/…?sslmode=require"
R2_ACCOUNT_ID="…"
R2_BUCKET="…"                       # also a GitHub *variable* in CI
R2_ACCESS_KEY_ID="…"
R2_SECRET_ACCESS_KEY="…"
# drill (if used):
DRILL_DATABASE_URL="postgres://…"
PG_LIVE_DATABASE_URL="postgres://…"
# slack (optional — TOKEN is the secret, CHANNEL is the paired non-secret id; both env):
SLACK_BOT_TOKEN="xoxb-…"
SLACK_CHANNEL="C…"
# failure webhook (optional, independent of the bot):
ALERT_WEBHOOK_URL="https://hooks.slack.com/services/…"
# dashboard upload (optional):
DASHBOARD_R2_BUCKET="…"
DASHBOARD_R2_ACCESS_KEY_ID="…"
DASHBOARD_R2_SECRET_ACCESS_KEY="…"
# staleness self-heal (optional):
GITHUB_REPOSITORY="owner/repo"
```

> `R2_BUCKET`, `DASHBOARD_R2_BUCKET`, and `SLACK_CHANNEL` are stored as GitHub **Variables** (not Secrets)
> in CI — they're the non-secret identifiers paired with the R2/Slack credentials; the DB URLs and
> `*_ACCESS_KEY*`/token values are **Secrets**. For the *local* doctor run the env values all go in this
> one file, and `PROFILE` points at the YAML for the rest.

---

## 5. Run doctor and interpret the result

`doctor` runs the **same** zod schema each task uses, then read-only client probes (R2 list,
Postgres connect, Slack `auth.test`, `gh` auth, binary + pg-client-version checks). It is strictly
read-only — no dump, no upload, no workflow trigger, no Slack post — so it's safe against production
credentials.

Run it with the secrets file sourced and `PROFILE` pointed at the profile:

```sh
set -a; source .context/gitfather-secrets.env; set +a
PROFILE=profiles/<name>.yaml npm run doctor -- all
```

`-- all` checks `backup`, `drill`, `verify-durable`, `staleness`, and `dashboard`. You can scope to one
task: `npm run doctor -- backup`.

**Reading the output** — each line is `✓` / `⚠` / `✗`:
- `✓ config — all variables present & valid` means the schema passed. A schema failure prints an
  aggregated, **names-only** report (it never echoes a secret value) and exits before any probe — fix
  the listed variables and re-run.
- `✓ <probe>` — that live check passed.
- `⚠ <probe>` — an **optional** check couldn't run (e.g. dashboard upload creds absent). Fine to leave
  if the user isn't using that feature.
- `✗ <probe>` — a **required** check failed. Must be fixed.

Exit code is `0` only when every required check passes. Iterate: fix what's flagged, re-run, until you
get `✓ doctor: all required checks passed`.

---

## Appendix A — Where each value comes from

When the user doesn't already have a value, walk them to its source. Paths below are current as of
mid-2026; if a UI label has moved, search the provider's docs rather than guessing.

### Cloudflare R2 (account id, bucket, S3 tokens, dashboard URL)

- **`R2_ACCOUNT_ID`** — `dash.cloudflare.com` → **R2 Object Storage** → the **Account Details** panel
  shows the Account ID (a 32-hex string). It's also the subdomain of the S3 endpoint
  `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.
- **`R2_BUCKET`** — `dash.cloudflare.com` → **R2 Object Storage** → the private dump bucket you
  created in the prereq step (its name).
- **`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`** — **R2 Object Storage** → **Manage API Tokens**
  (under Account Details) → **Create API token** → permission **Object Read & Write** → **scope to
  the specific bucket** → Create. Copy the **Access Key ID** and the **Secret Access Key** (the
  secret is shown **once**). The S3 endpoint is shown on the same screen.
  - The dashboard preset *does* include delete; this engine doesn't rely on the token to prevent
    deletion — **R2 bucket object-lock** (set in the prereq step) makes the durable tiers immutable
    regardless. Choosing the bucket-scoped Object R&W token keeps blast radius small.
- **`DASHBOARD_R2_BUCKET` / `DASHBOARD_R2_ACCESS_KEY_ID` / `DASHBOARD_R2_SECRET_ACCESS_KEY`** — same
  token flow, but on the **separate public** dashboard bucket (write is all that's needed).
- **`dashboard.url`** — the public hostname (`pub-<hash>.r2.dev` or a custom domain) is **not**
  derivable from the bucket name. **Fetch it yourself after asking permission** (the command uses the
  user's account-level Cloudflare login): `npx wrangler r2 bucket dev-url get <DASHBOARD_R2_BUCKET>`
  (managed URL) or `npx wrangler r2 bucket domain list <DASHBOARD_R2_BUCKET>` (custom domain). See the
  "Getting `dashboard.url`" note in §3d for the permission prompt. It's also visible in the bucket's
  **Settings → Public Access** (R2.dev subdomain / Custom Domains) if the user prefers to read it off.

### Slack (bot token, channel id)

- **`SLACK_BOT_TOKEN`** — `api.slack.com/apps` → **Create New App** → **From scratch** → pick the
  workspace. Then **OAuth & Permissions** (left sidebar) → **Scopes → Bot Token Scopes** → add
  **`chat:write`** → **Install to Workspace** → authorize → copy the **Bot User OAuth Token**
  (starts with `xoxb-`). **Then invite the bot to the target channel** (`/invite @YourBot`) — it
  can't post to a channel it isn't in.
- **`SLACK_CHANNEL`** — open the channel in Slack → click the channel name to open details → scroll
  to the bottom for the **Channel ID** (`C…`). (Or right-click the channel → **Copy link**; the ID
  is the last path segment.)
- **`ALERT_WEBHOOK_URL`** (optional, independent of the bot) — an **incoming webhook** URL. In Slack:
  `api.slack.com/apps` → your app → **Incoming Webhooks** → enable → **Add New Webhook to Workspace**
  → pick a channel → copy the `https://hooks.slack.com/services/…` URL. Any service that accepts a
  `{"text":…}` POST works too — e.g. a host app's existing incoming-webhook endpoint.

### Postgres (connection URLs)

- **`PG_BACKUP_DATABASE_URL`** — from the DB provider's **Connect / Connection string** panel:
  `postgres://USER:PW@HOST:5432/DB?sslmode=require`. If the provider offers a pooler, use the
  **session** pooler.
- **`PG_LIVE_DATABASE_URL`** — usually the same as the backup URL (read-only row counts).
- **`DRILL_DATABASE_URL`** — a **separate, throwaway** database you provision specifically for the
  drill; its contents get replaced on each restore.

### GitHub (where the values live in CI)

- **Secrets / Variables** — repo → **Settings → Secrets and variables → Actions**. Put sensitive
  values (DB URLs, `*_ACCESS_KEY*`, `SLACK_BOT_TOKEN`, `HEARTBEAT_URL`, age keys) under the
  **Secrets** tab; put `R2_BUCKET`, `DASHBOARD_R2_BUCKET`, and `SLACK_CHANNEL` under the **Variables** tab.
- Pushing the workflow files themselves needs a token with the **`workflow`** scope.

### age encryption (only if `encryption: age`)

- `age-keygen -o key.txt` prints the **public key** (`age1…`) → that's **`AGE_RECIPIENT`**; the file's
  `AGE-SECRET-KEY-…` line is **`AGE_IDENTITY`** (keep it secret; the drill needs it to decrypt).

### Heartbeat (optional)

- **`HEARTBEAT_URL`** — create a check at a dead-man's-switch service (e.g. healthchecks.io) and copy
  its **ping URL**.

---

## 6. Hand-off checklist

Once doctor is green locally, tell the user the remaining steps the engine can't do for them:

1. Commit `profiles/<name>.yaml` to their consuming repo (verify no secret leaked in).
2. Move the credentials from `.context/gitfather-secrets.env` into GitHub **Secrets** (and the three
   bucket/channel values into GitHub **Variables**) — see the README secrets/variables table.
3. Wire the caller workflows (`pg-backup.yml`, `pg-durable-verify.yml` — daily; supersedes the weekly
   `pg-restore-drill.yml` — `pg-staleness-check.yml`, `pg-dashboard.yml`) per the README "Wiring a
   consuming repo" section, pointing `profile:` at the new profile.
4. Delete `.context/gitfather-secrets.env` (or keep it knowing it's gitignored) once secrets are in GitHub.
