# Configuration, `doctor`, and troubleshooting

## Profile reference

The profile is a single **nested YAML** file ([`profiles/example.yaml`](../profiles/example.yaml), kebab-case
keys). Credentials are **never** in it — they come from the environment (GitHub secrets). Top level:
`name` (db shortname), `backup-prefix`, `timezone`, `encryption`, `anchor-hour-utc`. Groups:

- **`dump:`** — `flags`, `client-major`, `min-bytes`
- **`integrity:`** — `checksum`, `check-structure`, `verify-before-encrypt`, `verify-after-upload`
- **`retention:`** — `grandson` / `son` / `father` / `grandfather` as natural-language durations
  (e.g. `13 weeks`, `2 years`); defaults `2 days` / `3 weeks` / `13 weeks` / `2 years`
- **`drill:`** — `row-count-table`, `present-tables` (must exist), `nonempty-tables` (must exist +
  non-empty), `min-row-ratio`, `max-row-ratio`, `max-row-drop`
- **`verify-durable:`** — `fresh`, `aged`, `retest-days`, `max-restores`, `keyless`, `rehash-per-run`, `rehash-max-age-days`, `drill-max-age-days`
- **`archive:`** *(optional — see [Archiving a table out of Postgres](archiving.md))* — `store-prefix`, `encryption` (`none`|`age`), `compression` (`zstd`|`gzip`|`none`), `compression-level`, and `tables:` — a list of `{ table, time-column, archive-after-weeks, prune-after-weeks, delete-batch-rows, max-weeks-per-run }`
- **`staleness:`** — `slot-minutes`, `grace-minutes`, `max-age-hours` (unset → derived from the cadence), `repage-minutes`, `heal-workflow`, `self-heal`, `dry-run`. Consumed by the [Worker's watchdog](../scheduler/README.md): the backup publishes the validated block to `_config/<name>/watchdog.json` on every run
- **`credential-rotation:`** — `max-age-days` (default `365`; 0 disables) and `track:` — the credential prefixes to
  watch, matching the ENV names (`R2_ACCESS_KEY_ID` → `R2`). A tracked prefix with no recorded
  rotation reports `unknown`, which is grouped with `due`. See
  [Knowing when a rotation is overdue](r2-setup.md#knowing-when-a-rotation-is-overdue)
- **`slack:`** — `channel` (or the env `SLACK_CHANNEL`, which wins), `alert-mention`  ·  **`dashboard:`** — `label`, `hide-run-links`, `url`, `path-prefix`

All have safe defaults — see **[Verifying backups and restoring for real](verify-and-restore.md)**.

---

## Config validation & `doctor`

Each task validates the profile (zod) at startup and **fails fast** with one aggregated report if any
field is missing or malformed — before any dump, upload, or trigger. The report names YAML fields by
their kebab key and credentials by their ENV name (that's where you set each), never echoing a value.
The grammars are strict where a typo is genuinely catchable and lenient where they can't prove validity:

| Strict (catches typos) | Lenient (presence + light shape) |
|---|---|
| `encryption` ∈ {`none`,`age`,`aes-gcm`} · `anchor-hour-utc` 0–23 · `drill.min-row-ratio` 0–1 · `drill.max-row-ratio` ≥ 1 · `drill.max-row-drop` 0–1 · `staleness.max-age-hours` > slot + grace (unset → derived) · `staleness.slot-minutes` 1–1440 · `staleness.grace-minutes` 0–720 · `archive.*` (`compression` ∈ {`zstd`,`gzip`,`none`}, `encryption` ∈ {`none`,`age`}, per-table `prune-after-weeks` ≥ `archive-after-weeks`, no duplicate table entries, `delete-batch-rows` 1–500000, `max-weeks-per-run` 1–10000) · `credential-rotation.max-age-days` 0–3650 · `dump.min-bytes`/`verify-durable.retest-days`/`verify-durable.max-restores` (ints) · `timezone` (real IANA zone) · `retention.*` (durations like `13 weeks`) · booleans `staleness.self-heal`/`dry-run` · `integrity.checksum`/`check-structure`/`verify-before-encrypt`/`verify-after-upload` · `verify-durable.fresh`/`aged` (YAML `true`/`false` or `1/0/yes/no/on/off`) | credential ENV vars: `*_DATABASE_URL` scheme = `postgres(ql)://` · R2 account id / keys · bucket names (whitespace-free) · `AGE_RECIPIENT`/`AGE_IDENTITY` · `SLACK_BOT_TOKEN` · table-name lists (`drill.present-tables`/`nonempty-tables`) · `archive.store-prefix` / `tables[].table` / `time-column` · `AGE_ARCHIVE_RECIPIENT` · `credential-rotation.track` (a list of prefix names) |

Conditional rules are enforced too: `encryption: age` ⇒ `AGE_RECIPIENT` (backup) / `AGE_IDENTITY`
(drill, and durable-verify **unless** `verify-durable.keyless`, which instead REFUSES an identity and
needs no database at all — a missing key must fail the run, never quietly reduce it to a hash-only
check that still reports success, so the two situations are told apart by a declaration rather than
by an absence); `integrity.verify-after-upload` + `encryption: age` ⇒ `AGE_IDENTITY` (backup);
`integrity.verify-before-encrypt` ⇒ `drill.row-count-table` + `DRILL_DATABASE_URL` but **never**
`AGE_IDENTITY`; `expect-recipient` set ⇒ it must equal `AGE_RECIPIENT`, or the config is rejected
before the dump rather than after a bucket of unopenable objects has accumulated;
`SLACK_BOT_TOKEN` set ⇒ `SLACK_CHANNEL`; an `archive:` block ⇒ `archive.store-prefix`, at least
one entry in `archive.tables`, and `PG_ARCHIVE_DATABASE_URL`; `archive.encryption: age` ⇒
`AGE_ARCHIVE_RECIPIENT`. Real credential/endpoint validity isn't guessed from a regex;
it's proven by `doctor`'s live probes.

`doctor` is a **read-only** preflight — *"is this consumer actually wired up?"* — for verifying a
freshly-configured repo before go-live. It runs the **same** config schema, then probes the external
clients (binaries on PATH, `pg_dump`/`pg_restore` version, R2 bucket reachable via `rclone lsf`,
Postgres via `select 1`, Slack `auth.test`). It performs **no writes** — no dump, no upload, no
workflow trigger, no Slack post — so it's safe against production creds.

```bash
npm run doctor -- backup           # one task: backup | archive | drill | verify-durable | dashboard
npm run doctor -- all              # every task's config + probes
PROFILE=profiles/example.yaml npm run doctor -- backup   # ✓/⚠/✗ checklist; exit 0 iff all required pass
```

Optionally add a `doctor all` step to CI before the real task. It complements (doesn't replace)
`build-dashboard`'s `--sample` and the watchdog's `staleness.dry-run` — those exercise one task's dry path;
`doctor` is the broader client preflight.

---

## Running locally (before relying on CI)

```bash
npm ci                                                   # one-time: installs tsx
export PG_BACKUP_DATABASE_URL='postgresql://…:5432/…?sslmode=require'
export R2_ACCOUNT_ID=… R2_BUCKET=<your-bucket> R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
export SLACK_BOT_TOKEN=xoxb-…                            # optional
# Run twice: the first posts the day's Slack message, the second UPDATES it with a 2nd tick.
FORCE_TIERS="2hourly daily" PROFILE=profiles/example.yaml npx tsx scripts/backup-pg-to-r2.ts
```

Any local dump file lives under a tmp dir and is removed on exit — never commit a dump (it may contain
PII).

---

## Troubleshooting

### Every run fails instantly with `✗ config validation failed` (e.g. `✗ PG_BACKUP_DATABASE_URL — must be set`)

The secrets are arriving **empty** — the task aborts at its zod config pre-flight (see
[Config validation & `doctor`](#config-validation--doctor)). The usual cause is using
**`secrets: inherit`** in a caller that lives in a **different org/account** from this repo.

> `secrets: inherit` only passes secrets to a reusable workflow **in the same organization or
> enterprise**. This repo is public and owned by `simonhac`, so a consumer in any other org/account
> gets *nothing* from `inherit`, and every secret reads as empty.

**Fix:** pass each secret **explicitly** and thread non-secret config as inputs — see
[Wiring a consuming repo](wiring-a-consuming-repo.md#2-add-the-caller-workflows-githubworkflows-in-your-repo). Only use
`secrets: inherit` if your caller is in the **same org** as this repo.

A useful sanity check: if `vars.R2_BUCKET` etc. also read empty, the `vars` context isn't crossing the
owner boundary either — which is why the callers pass bucket/channel names as inputs rather than reading
`vars.*` inside the reusable workflow.

### Backups are failing but Slack shows nothing (only the dead-man's-switch paged)

This is expected, not a second bug. The Slack daily row is **in-band** — it's written *by the backup
script*, so it can only report failures the script reaches far enough to handle (a failed `pg_dump`,
a bad upload, a too-small dump). Failures *before* that point — empty secrets, a workflow that won't
start, a runner that dies, the dispatch not landing — never reach the Slack code. Two out-of-band
watchers cover exactly these cases: the [Worker's staleness watchdog](../scheduler/README.md) pages when
no object lands for a slot (and tries one catch-up dispatch first), and the **dead-man's-switch**
(`HEARTBEAT_URL` → healthchecks.io etc.) pages on the *absence* of a success ping even if the Worker
itself is down. Treat a STALE page or a healthchecks alarm with a quiet Slack row as "the
wiring/secrets/runner is broken," and check the Actions run logs.

### An amber "Drill failed" cell, or a `restore-drill`/`durable-verify FAILED` page

A drill restored a dump but the **data gate** didn't pass — this is *not* a failed backup (those are
red). The Slack/webhook message names the reason. Common ones:

- *"`<table>` is empty/zero"* or *"< `drill.min-row-ratio`× live"* — a genuinely truncated dump, **or** a sentinel
  table whose live `n_live_tup` estimate is stale (run `ANALYZE`, or widen `drill.min-row-ratio`).
- *"N unrecognised error(s): …"* — `pg_restore` emitted an error not in the benign managed-schema
  allow-list (`scripts/lib/pgRestore.ts`). If it's actually harmless for your provider, that file is the
  one place to add the pattern.
- *"`<table>` dropped X% vs prior drill"* — only with `drill.max-row-drop` set; a real shrink or an
  over-tight threshold.

A failed **durable** verify (`verify-durable-pg.ts`) on an *aged* copy uses a non-empty gate (it can't
compare to current live), so its failures mean the object didn't restore or an expected table was empty —
investigate that specific object. Every failure is recorded to the verifications log (the amber cell), so
the dashboard shows it even after the alert scrolls away.

### The staleness check pages constantly with `> Nh backstop`

`staleness.max-age-hours` is a **backstop**, and it has to be looser than the slot logic it backs up,
or it fires on a perfectly healthy schedule. The rule:

```
max-age-hours  >  slot-minutes / 60  +  grace-minutes / 60
```

Config validation enforces it at backup time (before the block is published to the Worker) — a
profile that sets the backstop inside a slot fails fast rather than paging on every tick — so if you
are seeing this symptom, the published config predates that check. The fix is usually to **delete the
key**: unset, `max-age-hours` is derived from the cadence as 1.5 slots (`12` h at the `480`/`25`
default), which cannot be wrong for the configured slot width. The next backup run republishes it.

### The watchdog reports `no-config` for a client

The Worker found no `_config/<name>/watchdog.json` in that client's bucket. The backup job writes it
on every run, so either no backup has run since the client was wired, or the run failed before
publishing (config validation). Dispatch one: `gh workflow run pg-backup.yml -f reason=schedule`.

### `Unrecognized named-value: 'vars'` when validating a workflow

You have a `${{ … }}` expression inside a `workflow_call` input `description:` — GitHub evaluates
expressions there, where `vars`/`secrets` aren't valid contexts. Use plain text in descriptions.
