# Setting up the-gitfather — an LLM-guided walkthrough

**Audience: an AI coding agent.** This document tells *you* (the assistant) how to interview a
human operator, collect every value the backup engine needs, write it to the right places, and
finish by running `doctor` so the human gets a green ✓ checklist before they trust the system.

Do not dump this whole document at the user. Work through it as a conversation: ask in small
batches, record answers as you go, explain *how to obtain* each value the user doesn't already
know, and only move on once a section is complete.

---

## Architecture & the critical path (read first)

the-gitfather is an **engine** repo. You don't fork it or run backups *from* it — you **call its
reusable workflows from the operator's own repo**. Their repo holds three things only: a **profile**,
thin **caller workflows**, and **secrets/variables**. Each reusable workflow checks out *two* repos at
run time: the caller repo (for the profile) and this one (for the scripts). Establish this with the user
up front — it's the single fact that makes everything below make sense.

```
their-repo                          the-gitfather (engine, public)
  pg-backup/<name>.yaml   ──┐         scripts/  +  dashboard/
  .github/workflows/        └─uses─►   .github/workflows/  (reusable: workflow_call)
    pg-backup.yml ────────────────►     pg-backup.yml
    pg-durable-verify.yml ────────►     pg-durable-verify.yml   (daily; supersedes the weekly drill)
    pg-dashboard.yml ─────────────►     pg-dashboard.yml
    pg-archive.yml ───────────────►     pg-archive.yml          (optional — the table archiver)
    pg-restore-drill.yml ─────────►     pg-restore-drill.yml    (optional — superseded by durable-verify)
```

**The critical path — drive it in this order:**

1. **Create the R2 bucket(s), lifecycle rules, WORM locks, and a scoped S3 token** (§1 +
   [r2-setup.md](r2-setup.md); account-level Cloudflare creds). For the dashboard, also create a
   **separate public** bucket + a write-only token. **`doctor` cannot pass until these exist.**
2. **Get a direct Postgres connection string** — not a transaction-mode pooler (§2b).
3. **Write the profile** (`pg-backup/<name>.yaml`, committed to their repo) and the local
   `.context/gitfather-secrets.env` (§4).
4. **Clone this engine repo, `npm ci`, and run `doctor`** against that profile (§5) — `npm run doctor`
   lives *here*, not in their repo.
5. **Move credentials into GitHub Secrets** (and `R2_BUCKET` / `DASHBOARD_R2_BUCKET` / `SLACK_CHANNEL`
   into **Variables**), then **add the caller workflows** ([wiring-a-consuming-repo.md](wiring-a-consuming-repo.md)),
   pointing `profile:` at the new file. The callers carry no `schedule:` cron — the
   [Cloudflare Worker](../scheduler/README.md) dispatches them and runs the staleness watchdog, so the
   client must also be added to the Worker's roster (with an R2 binding to its bucket). Pushing
   workflow files needs a token with the **`workflow`** scope.
6. **Prove it:** trigger `pg-backup` via `workflow_dispatch` and confirm an object lands in R2.

**Three things `doctor` cannot catch — a green checklist is *not* a proven backup:**

- a **transaction-mode pooler** that answers `select 1` but breaks `pg_dump` (§2b);
- a **lifecycle / bucket-lock** misconfiguration — `doctor` only probes that the bucket is *reachable*,
  not that retention/immutability are correct;
- **`secrets: inherit` across owners** — it silently passes *nothing* when the caller repo is owned by a
  different account than this one, so every secret reads empty (see
  [configuration-and-troubleshooting.md](configuration-and-troubleshooting.md#troubleshooting)). The
  caller workflows must pass each secret explicitly.

Only a real backup run (a `workflow_dispatch` of `pg-backup`, or a local `backup-pg-to-r2.ts`) proves
the end-to-end path.

---

## 0. The shape of the task

There are **two kinds of input**, and they live in **two different files**:

| Kind | What | Where it goes | Committed? |
|---|---|---|---|
| **Config** | project choices (prefix, basename, schedule, thresholds, tz…) | `pg-backup/<name>.yaml` (in the consuming repo) | ✅ yes — checked into the consuming repo |
| **Credentials** | DB URLs, R2 keys, Slack token… | environment / GitHub Secrets; locally a **gitignored** file under `.context/` | ❌ **never** committed |

Your job is to produce three things, in order:

1. `.context/gitfather-setup.md` — the running interview record (what the user told you, decisions, open questions).
2. `pg-backup/<name>.yaml` — the committed config profile **in the consuming repo** (copied *out of* the engine's `profiles/example.yaml`, then filled in; don't edit the engine's copy in place).
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
- CLI tools on PATH: `rclone`, `pg_dump`, `pg_restore`, `psql`. Plus `age` **only if** they choose `encryption: age`.
- If they're enabling the **archiver** (§3g): `zstd` (or `gzip`) for compression and `age` for archive
  encryption — note `age` is needed for `archive.encryption: age` even when the dumps themselves are
  unencrypted, because the archive uses its own recipient.
- The Cloudflare R2 buckets already exist with lifecycle + lock rules applied. This is a **one-time manual step** done with account-level Cloudflare creds — see [r2-setup.md](r2-setup.md). The engine does **not** create buckets; `doctor` only probes that they're reachable. This is **critical-path step 1** (see the Architecture section) — nothing else can be validated until it's done. If you're enabling the dashboard, also create a **separate public** bucket + a **write-only** S3 token for it.

If buckets don't exist yet, pause the setup and walk the user through the
[`wrangler r2 bucket create / lifecycle add / lock add`](r2-setup.md#create-the-r2-bucket-lifecycle-rules-and-bucket-locks-once)
commands first.

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
| `PG_BACKUP_DATABASE_URL` | source DB to dump | `postgres://USER:PW@HOST:5432/DB?sslmode=require`. From the DB provider's connection-string panel. Use a **direct** (or session-*mode*) endpoint — **never a transaction-mode pooler**. Many providers' copy-paste string defaults to a PgBouncer pooler on **port 6432** (e.g. PlanetScale, Supabase); `pg_dump` needs the **direct** endpoint (often port **5432**) or it can fail/stall. doctor's `select 1` passes over a pooler, so confirm with a real `pg_dump`. |

For the **restore drill** (only if they want automated restore verification — recommended):

| Variable | Meaning | How to get it |
|---|---|---|
| `DRILL_DATABASE_URL` | a *throwaway* DB the drill restores into (gets wiped) | a separate empty database / instance |
| `PG_LIVE_DATABASE_URL` | live DB used only to read row counts for the ratio check | usually same as `PG_BACKUP_DATABASE_URL` |
| `drill.row-count-table` | `public.<table>` whose restored/live row ratio is asserted | the user's largest stable table |

> `DRILL_DATABASE_URL` and `PG_LIVE_DATABASE_URL` are only needed for a **local** `doctor -- drill`.
> In CI the reusable drill and durable-verify workflows supply them themselves (the restore target is
> a throwaway Postgres service container inside the job) — the operator does *not* set them as repo
> secrets.

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
| `staleness.max-age-hours` | derived: `12` at the default cadence | backstop: alert if the newest object is older than this (the **primary** trigger is the slot-based overdue check — see 3e). Leave it unset unless the operator has a reason: unset derives 1.5 slots from `slot-minutes`, and a value inside `slot-minutes + grace` is **refused** by config validation |
| `drill.min-row-ratio` | `0.95` | restored/live row-count floor for the drill sentinel table |
| `drill.max-row-ratio` | `2.0` | restored/live row-count ceiling — catches duplicated/double-restored rows |
| `dump.flags` | `-Fc --no-owner --no-privileges` | pg_dump flags; tune per database (e.g. `--exclude-schema=…`) |
| `dump.client-major` | (unset) | **Ask the operator their Postgres *server* major and set this.** `doctor` then checks your `pg_dump`/`pg_restore` major ≥ this; the client major must be **≥ the server major**, and the drill / durable-verify `postgres:NN` service image must be **≥** it too (bump both together). |
| `drill.present-tables` | (none) | space-separated tables that must each **exist** after restore (rows optional) |
| `drill.nonempty-tables` | (none) | space-separated tables that must each exist **and** have ≥1 row after restore |

> `FORCE_TIERS` is **not** a profile key — it's an **env var for manual runs only** (a space-separated
> subset of `2hourly daily weekly monthly` that forces promotion to those tiers). Set it in the
> workflow/env at dispatch time; never write it into the YAML.

### 3b. Encryption (→ profile + secrets)

| Variable | Default | Meaning |
|---|---|---|
| `encryption` | `none` | `none` \| `age` \| `aes-gcm` (aes-gcm not implemented) |
| `AGE_RECIPIENT` | — | **required when `encryption: age`** (public key, `age1…`); used to encrypt |
| `AGE_IDENTITY` | — | private key; used by the drill + durable-verify to decrypt (and by the backup only when `integrity.verify-after-upload`). NOT needed to take a backup, and not needed by `integrity.verify-before-encrypt` |

### 3c. Slack status row (→ profile + secrets)

| Variable | Default | Meaning |
|---|---|---|
| `SLACK_BOT_TOKEN` | (unset → Slack off) | `xoxb-…`, scope `chat:write` (secret, env) |
| `SLACK_CHANNEL` / `slack.channel` | — | channel id `C…` (non-secret — either the env Variable or the profile key; env wins). **Required if `SLACK_BOT_TOKEN` is set** (else the row silently never posts). The Worker's watchdog posts to the same channel |
| `slack.alert-mention` | `<!here>` | prepended to failure alerts (`<!here>` / `<!channel>`) — profile |
| `timezone` | `UTC` | IANA tz for the daily row's date + HH:MM labels (e.g. `Australia/Perth`) |
| `dashboard.url` | (unset) | if set, hyperlinks the Slack header's "`<basename> DB backup`" text to the dashboard. See note below on how to obtain it. |
| `ALERT_WEBHOOK_URL` | (unset) | optional **failure** webhook (secret), independent of the bot — a Slack-compatible `{"text":…}` POST on backup/drill failure. A no-bot alert fallback, or a redundant failure channel into a host app's existing incoming webhook. Fires on failure only (no success spam). The watchdog's copy is a Worker secret (`ALERT_WEBHOOK_URL_<ID>`). |

### 3d. Public dashboard (→ profile + secrets)

| Variable | Default | Meaning |
|---|---|---|
| `dashboard.label` | `name` | project label shown on the public page |
| `dashboard.hide-run-links` | `false` | also drop run links from the public page |
| `dashboard.path-prefix` | `""` | object-key prefix in the dashboard bucket: `<path-prefix>/<name>/index.html` (`""` → `<name>/index.html`). Set it (e.g. `backups`) to share **one** dashboard bucket + custom domain across projects — e.g. `https://ops.example.com/backups/<name>/index.html`. Keep `dashboard.url` consistent with it. |
| `DASHBOARD_R2_BUCKET` | — | the **separate public** bucket the built page is uploaded to (variable) — may be **shared** across projects when `path-prefix`/`name` keep their keys distinct |
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

The watchdog itself runs in the [Cloudflare Worker](../scheduler/README.md) every 10 minutes; these
keys are still written **here**, because the backup job publishes the validated block to
`_config/<name>/watchdog.json` in the bucket on every run, and the Worker reads it there. An edit
lands with the next backup run (or a manual `workflow_dispatch` of `pg-backup`).

| Variable | Default | Meaning |
|---|---|---|
| `staleness.slot-minutes` | `480` | backup cadence in minutes — **must match the Worker's backup cadence** (00/08/16 UTC = 480). The primary freshness trigger: a slot with no backup past its grace window is "overdue" |
| `staleness.grace-minutes` | `25` | minutes past a slot boundary before it counts as overdue (**must be < slot-minutes**). Trades faster recovery against redundant heals on scheduler jitter |
| `staleness.repage-minutes` | `60` | minutes between **loud** re-pages while an outage persists. The check runs every ~10 min, so paging on every tick turns a long outage into dozens of identical `@here` messages; entry into an outage and any change of **cause** still page immediately. `0` restores page-every-tick. Affects Slack only — every tick's outcome is still recorded in the scheduler's state, and a recovery note is posted when a fresh backup lands |
| `staleness.self-heal` | `true` | on a missed slot, dispatch the backup caller workflow (`reason=self-heal` → 🩹) |
| `staleness.dry-run` | `false` | staleness check evaluates but takes no action |
| `staleness.heal-workflow` | `pg-backup.yml` | the caller workflow file (in the consuming repo) self-heal dispatches |
| `HEARTBEAT_URL` | (unset) | optional dead-man's-switch URL pinged on success (e.g. healthchecks.io) |

> `dump.min-bytes` is **also** the staleness floor: a fresh-but-smaller newest object is treated as broken
> (pages directly) rather than just stale.

> **The backstop must be looser than the slot logic**: `max-age-hours > slot-minutes/60 + grace-minutes/60`,
> or the check pages on every healthy tick — mid-slot, the newest object is always older than a tight
> backstop. Config validation refuses such a value outright. Omitting `max-age-hours` derives it
> (1.5 slots: `12` h at the 480/25 default), which is the recommendation.

### 3f. Backup integrity & durable verification (→ profile, defaults fine)

All default-on and safe — surface them only if the user asks *"how do you know the backups are good?"*

| Variable | Default | Meaning |
|---|---|---|
| `integrity.checksum` | `true` | record a SHA-256 of each uploaded object (the durable hash-verify baseline) |
| `integrity.check-structure` | `true` | `pg_restore -l` TOC check on the PLAINTEXT, before it is encrypted — so it applies to every `encryption:` mode |
| `integrity.verify-before-encrypt` | `false` | opt-in: full `pg_restore` + `drill.*` row gates on the plaintext, EVERY run. Needs `drill.row-count-table` + `DRILL_DATABASE_URL`, and deliberately NOT `AGE_IDENTITY`. Records a `pre-encrypt` verification |
| `expect-recipient` | — | the recipient `AGE_RECIPIENT` must match, pinned in the profile. An age header does not name its recipient, so this is the only keyless guard against encrypting to a key you no longer hold |
| `integrity.verify-after-upload` | `false` | opt-in: re-download + (decrypt) + `pg_restore -l` after upload. Under `encryption: age` this needs `AGE_IDENTITY` in the backup job, which the reusable `pg-backup.yml` deliberately does not accept — prefer `verify-before-encrypt`, which proves more and needs no key |
| `verify-durable.fresh` | `true` | daily verify: hash-check each new durable object + restore the freshest `daily` |
| `verify-durable.aged` | `true` | daily verify: restore the newest `weekly`/`monthly` ≥ `verify-durable.retest-days` old not yet restore-verified |
| `verify-durable.retest-days` | `14` | age at which a weekly/monthly becomes secondary-due (set `13` to re-test inside the 14-day WORM lock) |
| `verify-durable.max-restores` | `2` | cap on full restores per daily verify run (hash-checks uncapped) |
| `verify-durable.rehash-per-run` | `1` | re-hash the N least-recently-hashed durable objects every run, so "the bytes are unchanged" stays a CURRENT claim rather than one made once on first sight. One per run sweeps a ~46-object corpus in ~46 days |
| `verify-durable.rehash-max-age-days` | `90` | page when the least-recently-hashed object exceeds this (0 disables). A rotation that stops decays coverage with no symptom otherwise |
| `verify-durable.drill-max-age-days` | `0` | warn when the newest MANUAL restore drill is older than this (0 disables). In keyless mode that drill is the only proof the escrowed key still opens a stored object, and it runs on a human cadence — so "somebody forgot" is otherwise the one failure mode with no signal at all |
| `verify-durable.keyless` | `false` | hash checks ONLY — no `AGE_IDENTITY`, no `DRILL_DATABASE_URL`/`PG_LIVE_DATABASE_URL`, no restores. Requires `aged: false`, and REFUSES an identity in the environment. Pair with `integrity.verify-before-encrypt` + a periodic manual decrypt drill |
| `drill.max-row-drop` | `0` (off) | if set (0–1), fail a drill when a table shrank more than this fraction vs the prior passing drill |

These power `verify-durable-pg.ts` (the daily `pg-durable-verify.yml` workflow), which guarantees every
durable file is tested — **weekly/monthly twice, daily once**. See
[verify-and-restore.md](verify-and-restore.md).

### 3g. Archiving a table (optional — ask, don't assume)

Only relevant if the operator has an **append-only** table that has outgrown the database (a request
log, an event log, an audit trail). It is off unless the profile has an `archive:` block. Backups
copy; the archiver **moves** — rows leave Postgres — so interview carefully and default to caution.
Full detail: [archiving.md](archiving.md).

| Variable | Default | Meaning |
|---|---|---|
| `archive.store-prefix` | — | object-key prefix, a **sibling** of `backup-prefix` (e.g. `archive/<name>`) |
| `archive.encryption` | `age` | `none` \| `age`. With `age` this uses **`AGE_ARCHIVE_RECIPIENT`**, *not* the dumps' `AGE_RECIPIENT` |
| `archive.compression` / `compression-level` | `zstd` / `12` | applied before encryption |
| `archive.tables[].table` | — | schema-qualified, e.g. `public.api_logs` |
| `archive.tables[].time-column` | `created_at` | must be NOT NULL and indexed; weeks are ISO-8601 on UTC boundaries |
| `archive.tables[].archive-after-weeks` | `4` | a week is eligible only once its **last** row is this old |
| `archive.tables[].prune-after-weeks` | `4` | ≥ archive-after-weeks. **Err wide** — widening later is free, narrowing deletes more and nothing deleted comes back |
| `archive.tables[].delete-batch-rows` | `2000` | small batches: one huge DELETE floods a realtime publication's slot |
| `archive.tables[].max-weeks-per-run` | `1` | the backfill throttle; override per run with `--max-weeks` |

Secrets: **`PG_ARCHIVE_DATABASE_URL`** (required — deliberately separate from the dump URL, because
this is the only task that DELETES) and, for `archive.encryption: age`, **`AGE_ARCHIVE_RECIPIENT`**
(the `age1…` **public** key only). Generate that identity **offline** and keep it in a password
manager — it must never become a repo secret. CI never decrypts an archive.

R2: the store prefix gets **no** lifecycle expiry rule (that absence is what makes archives permanent)
plus a 90-day bucket lock — see [r2-setup.md → The archive prefix](r2-setup.md#the-archive-prefix).

Then, in order: `npm run doctor -- archive` (needs `PG_ARCHIVE_DATABASE_URL`), a rehearsal with
`--target=local:<dir>`, then `--dry-run=store` against R2, then a real `--mode archive` batch. Prune
last, and only after spot-checking a decrypted object. A first backfill of a legacy table is worked
off in batches — [archiving.md → Backfilling a legacy table](archiving.md#backfilling-a-legacy-table).

---

## 4. Write the files

### 4a. Interview record — `.context/gitfather-setup.md`

Keep a living markdown record as you interview: every value provided (redact secret values to a
placeholder like `‹set›`), every default accepted, and any TODOs (e.g. "bucket not created yet").
This is your scratchpad and the user's audit trail.

### 4b. Profile — `pg-backup/<name>.yaml` (in the consuming repo)

Start from the engine's `profiles/example.yaml` — copy it **out** into the consuming repo (e.g.
`pg-backup/<name>.yaml`), don't edit it in place — and fill in the **config** values only — a single nested **YAML**
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
# archive (optional — the archiver is the only task that DELETES from the source):
PG_ARCHIVE_DATABASE_URL="postgres://…"
AGE_ARCHIVE_RECIPIENT="age1…"        # public key only; its identity stays OFFLINE
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

> **Where doctor runs.** `npm run doctor` is a script of *this* (engine) repo, not the consuming repo.
> Run it from a checkout of the-gitfather, with `$PROFILE` pointed at the consuming repo's profile and
> the secrets file sourced:
>
> ```sh
> git clone https://github.com/simonhac/the-gitfather && cd the-gitfather && npm ci
> set -a; source /path/to/your-repo/.context/gitfather-secrets.env; set +a
> PROFILE=/path/to/your-repo/pg-backup/<name>.yaml npm run doctor -- all
> ```

> **A green doctor is *not* a proven backup.** doctor checks *wiring* — it runs no dump, upload,
> promotion, or restore. It can't catch a transaction-mode pooler that breaks `pg_dump` (§2b), a
> lifecycle/lock misconfig, or `secrets: inherit` failing across owners. Treat the real go-live gate as a
> manual `workflow_dispatch` of `pg-backup` (or a local `backup-pg-to-r2.ts` run) that lands an object in
> R2.

`-- all` checks `backup`, `archive`, `drill`, `verify-durable`, and `dashboard`. You can
scope to one task: `npm run doctor -- backup`. `doctor -- archive` needs `PG_ARCHIVE_DATABASE_URL`
and only makes sense once the profile has an `archive:` block.

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
September 2026; if a UI label has moved, search the provider's docs rather than guessing.

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
  `postgres://USER:PW@HOST:5432/DB?sslmode=require`. Use a **direct** (or session-*mode*) endpoint,
  **never a transaction-mode pooler**: many providers default the copy-paste string to a PgBouncer
  pooler on **port 6432** (e.g. PlanetScale, Supabase), but `pg_dump` needs the **direct** endpoint
  (often port **5432**). doctor's `select 1` succeeds over a pooler, so verify with a real `pg_dump`.
- **`PG_LIVE_DATABASE_URL`** — usually the same as the backup URL (read-only row counts).
- **`DRILL_DATABASE_URL`** — a **separate, throwaway** database you provision specifically for the
  drill; its contents get replaced on each restore.

### GitHub (where the values live in CI)

- **Secrets / Variables** — repo → **Settings → Secrets and variables → Actions**. Which name is a
  secret and which is a variable is listed once, in
  [wiring-a-consuming-repo.md § 3](wiring-a-consuming-repo.md#3-set-the-secrets--variables-in-your-repo);
  use that table rather than restating it.
- Pushing the workflow files themselves needs a token with the **`workflow`** scope.

### age encryption (only if `encryption: age`)

- `age-keygen -o key.txt` prints the **public key** (`age1…`) → that's **`AGE_RECIPIENT`**; the file's
  `AGE-SECRET-KEY-…` line is **`AGE_IDENTITY`** (keep it secret; the drill needs it to decrypt).
- **age (archive)** — run `age-keygen` a **second** time for the archiver, on the operator's machine.
  Only the `age1…` recipient becomes a secret (`AGE_ARCHIVE_RECIPIENT`); the identity goes into a
  password manager and **never** into GitHub. That asymmetry is the point: CI verifies archives by
  hash and fingerprint, so it never needs to decrypt one, and a leaked CI credential cannot read a
  single archived row. `age-keygen -y key.txt` re-derives the recipient if they need to check the pair.

### Heartbeat (optional)

- **`HEARTBEAT_URL`** — create a check at a dead-man's-switch service (e.g. healthchecks.io) and copy
  its **ping URL**.

---

## 6. Hand-off checklist

Once doctor is green locally, tell the user the remaining steps the engine can't do for them:

1. Commit `pg-backup/<name>.yaml` to their consuming repo (verify no secret leaked in).
2. Move the credentials from `.context/gitfather-secrets.env` into GitHub **Secrets** (and the
   bucket/channel values into GitHub **Variables**) — see the
   [secrets/variables table](wiring-a-consuming-repo.md#3-set-the-secrets--variables-in-your-repo).
3. Wire the caller workflows (`pg-backup.yml`, `pg-durable-verify.yml` — daily; supersedes the weekly
   `pg-restore-drill.yml` — `pg-dashboard.yml`, plus `pg-archive.yml` if they archive) per
   [wiring-a-consuming-repo.md](wiring-a-consuming-repo.md), pointing `profile:` at the new profile.
   **Pass every secret explicitly** — `secrets: inherit` silently passes nothing across owners (the #1
   first-run failure). Pushing the workflow files needs a token with the **`workflow`** scope.
4. Add the client to the [Worker's roster](../scheduler/README.md) with an R2 binding to its bucket —
   the Worker dispatches every cadence and runs the staleness watchdog. Remember `archive` is
   **opt-in**, so its `cadences` list must name `"archive"` explicitly. The watchdog reports
   `no-config` until the first backup run publishes the profile's `staleness:` block to the bucket.
5. If a first archive backfill ran, schedule a **`VACUUM FULL`** on that table: a plain `DELETE` only
   marks space reusable, so without it the table stops growing but never shrinks. It takes an
   `ACCESS EXCLUSIVE` lock — size the window to the table.
6. Delete `.context/gitfather-secrets.env` (or keep it knowing it's gitignored) once secrets are in GitHub.
