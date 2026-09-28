# R2 buckets, retention, locks and tokens

Everything the-gitfather stores lives in **one private R2 bucket** (plus a separate public bucket for
the [dashboard](dashboard.md)). Retention and immutability are enforced by **R2 lifecycle rules and
bucket locks**, not by the scripts — so this page is the one you follow once, per bucket, with
account-level Cloudflare credentials.

## Backup tiers (GFS + a finer "grandson" tier)

| Tier | Label | Cadence | R2 prefix | Lifecycle expiry (default) | Bucket lock |
|---|---|---|---|---|---|
| intraday | grandson | `backups-per-day` (default 3: every 8 h) | `<prefix>/intraday/` | 2 days | none |
| daily | Son | anchor hour | `<prefix>/daily/` | 3 weeks | 14 days |
| weekly | Father | Sundays @ anchor | `<prefix>/weekly/` | 13 weeks | 14 days |
| monthly | Grandfather | 1st @ anchor | `<prefix>/monthly/` | 2 years | 14 days |

The cadence is the profile's `backups-per-day` (a factor of 24), phased from `anchor-hour-utc`: at the
default 3 a day with anchor 16 that is 00/08/16 UTC; at 1 a day, just the anchor hour. The dashboard
and Slack render the real cadence.

> **Migrating from `2hourly/`.** The intraday tier used to be written to `<prefix>/2hourly/`. Add the
> `expire-intraday` rule below **before** upgrading; the watchdog, restore drill and durable-verify read
> both prefixes for one release, so nothing pages during the switch. Once `2hourly/` has emptied (its
> 2-day rule), remove it: `npx wrangler r2 bucket lifecycle remove <your-bucket> --id expire-2hourly`.

The expiry windows are the **profile's `retention:` block** (natural-language durations — see the
[profile reference](configuration-and-troubleshooting.md#profile-reference)); the values above are the
defaults. At most ~82 backups are retained at once. **These windows
are also what the dashboard renders, but R2 itself does the deleting** via the lifecycle rules below —
keep the two in sync (changing the profile does not reconfigure R2).

**One dump, promoted to all qualifying tiers.** Each run dumps once and uploads to `intraday/`. The run
whose UTC hour equals `anchor-hour-utc` is also **server-side copied** (R2→R2, no re-dump) into `daily/`,
plus `weekly/` on Sundays, plus `monthly/` on the 1st. Retention and immutability are enforced by **R2
lifecycle rules + bucket locks per prefix**, not by code.

### Create the R2 bucket, lifecycle rules, and bucket locks (once)

Run with **account-level** Cloudflare creds (this credential is the one that can weaken locks — **never**
give it to CI). Replace `<your-bucket>` and `<prefix>` (your profile's `backup-prefix`).

```bash
npx wrangler r2 bucket create <your-bucket>

# Lifecycle: expire each tier on its own schedule
# Match these --expire-days to the profile's retention: block (defaults: 2 days / 3 weeks / 13 weeks / 2 years).
npx wrangler r2 bucket lifecycle add <your-bucket> expire-intraday <prefix>/intraday/ --expire-days 2
npx wrangler r2 bucket lifecycle add <your-bucket> expire-daily   <prefix>/daily/   --expire-days 21
npx wrangler r2 bucket lifecycle add <your-bucket> expire-weekly  <prefix>/weekly/  --expire-days 91
npx wrangler r2 bucket lifecycle add <your-bucket> expire-monthly <prefix>/monthly/ --expire-days 730
npx wrangler r2 bucket lifecycle add <your-bucket> abort-mpu      <prefix>/         --abort-multipart-days 1
npx wrangler r2 bucket lifecycle add <your-bucket> expire-status  _status/          --expire-days 14
npx wrangler r2 bucket lifecycle add <your-bucket> expire-log     _log/             --expire-days 760
# _status/ also holds each run's outcome record (_status/_outcome/), which the scheduler Worker reads to
# post to Slack. The same 14-day rule expires them; no extra rule is needed.
# _config/ (the watchdog config the backup publishes for the Worker) and _health/ (the job proofs
# verify and archive publish for /health/jobs) are overwritten every run and must NOT be locked or
# expired — like _status/, they are control-plane state, not backups.

# Bucket locks (WORM): 14-day immutability on the DURABLE tiers only — NOT on intraday/ (a lock there
# would block its 2-day expiry, since locks take precedence over lifecycle).
npx wrangler r2 bucket lock add <your-bucket> lock-daily   <prefix>/daily/   --retention-days 14
npx wrangler r2 bucket lock add <your-bucket> lock-weekly  <prefix>/weekly/  --retention-days 14
npx wrangler r2 bucket lock add <your-bucket> lock-monthly <prefix>/monthly/ --retention-days 14
```

Then mint a **scoped R2 S3 API token** for CI, scoped to this bucket. Prefer Object **Read & Write**
with **no delete**; that token cannot delete locked objects, overwrite them (keys are unique), or
change lock/lifecycle config — it is the only R2 credential CI gets.

> **The locks are the guard, not the token preset.** Cloudflare's dashboard presets are coarse — the
> nearest one ("Object Read & Write") includes delete, and building a genuinely delete-free token means
> a custom policy. Do that if you can, but do not treat it as the control that matters: the **bucket
> locks** are what actually stop a leaked CI credential erasing durable backups, and they hold whatever
> the token's verbs say. A token that can delete plus locks on `daily/`/`weekly/`/`monthly/` is a sound
> configuration; a no-delete token with no locks is not.

For the dashboard, create a **separate public** bucket and a **write-only** token for it (the dump
bucket gains no web surface).

### `_status/_outcome/` — what the jobs leave for Slack

Every CI run of backup, durable-verify, restore-drill and archive writes one small JSON **outcome
record** to `_status/_outcome/<YYYYMMDDTHHMMSSZ>_<runId>_<attempt>_<job>_<name>.json` as it exits.
It uses the same CI token; local runs write none. The [scheduler Worker](../scheduler/README.md)
reads these records through its R2 binding and is the only thing that posts to Slack
([how](slack-and-alerting.md#how-a-run-reaches-slack)). The Worker records its delivery state **on
each record, as R2 custom metadata**: `gf-state` (`claimed`, `posted`, `invalid`, `rejected`,
`gave_up`), `gf-at`, `gf-tries`, and `gf-error`. It rewrites the object in place to do so, with a
compare-and-swap on its etag. So `_status/_outcome/` must stay **unlocked**, like the rest of
`_status/`. A record holds the run's status, its summary and its alert reasons, the same kind of
text the run-log keeps. A config failure names only the failing fields. The existing 14-day
`expire-status` rule expires the records. `rclone lsjson -M r2:<bucket>/_status/_outcome/`
shows each record with its delivery state.

---

## The archive prefix

If you use the [table archiver](archiving.md), its store prefix is set up the opposite way round.
Archives are meant to be **permanent**, which is the inverse of the GFS tiers:

```bash
# NO lifecycle expiry rule on <store-prefix>/ — that absence is what makes archives permanent.
# A lock for ransomware resistance. Locks OUTRANK lifecycle, so never combine the two here.
npx wrangler r2 bucket lock add <your-bucket> lock-archive <store-prefix>/ --retention-days 90
```

Two mechanisms, deliberately not conflated: permanence comes from the missing expiry rule; resistance
to a leaked credential comes from the lock. 90 days rather than the dumps' 14 because there is no short
expiry to fight, and it still lets a human with account-level creds clean up an early mistake. The lock
must **not** cover `_index/`, which is rewritten in place — it is a materialised view of the manifests,
recoverable at any time with `--rebuild-index`.

The same CI token works: Object Read & Write, no delete.

---

## The recovery-kit prefix

The [recovery kit](key-escrow.md#the-recovery-kit) lives in the same bucket as the backups, under
`recovery-kit/` at the bucket root. Like the archive prefix it must be **permanent**: no lifecycle rule
covers it (the rules above are all under `<prefix>/`, `_status/` and `_log/`). Unlike the archive, it
never needs cleaning up, since each kit is small and written once, so it is locked **indefinitely**:

```bash
# NO lifecycle expiry rule on recovery-kit/.
npx wrangler r2 bucket lock add <your-bucket> lock-recovery-kit recovery-kit/ --retention-indefinite
```

The lock stops a leaked credential deleting or overwriting a kit. Removing a kit means removing this
rule first, with account-level credentials. Uploading and verifying need only the CI token.

---

## Rotating an R2 token — `npm run roll-r2`

Rolling an R2 API token is the only way to **learn** its credential: neither Cloudflare nor GitHub
will show you an existing one again. So the roll is simultaneously the one moment escrow is
possible and the one moment it is easy to get wrong — the old credential dies immediately, the new
one is displayed once, and nothing downstream can be read back to check what you stored.

```bash
PROFILE=<path-to-profile.yaml> \
npm run roll-r2 -- --vault <1password-vault> --bucket <r2-bucket> --account-id <cf-account> \
  [--prefix R2] [--repo owner/name] [--dry-run]
```

When `--repo` is supplied, `PROFILE` names the run-log for the rotation record. If recording fails,
escrow and publication remain complete and the tool reports a warning. Without `--repo`, the tool
escrows the credential but neither publishes it nor records its rotation.

### Doing it, start to finish

The tool is only the second half. The half before it happens in the Cloudflare dashboard, and it is
the half with no undo.

**1. Roll the token in Cloudflare.** R2 → **API tokens** → the existing CI token → **Roll**. Roll it;
do not create a new one. A roll reissues the *value* and keeps the token's id and its permissions,
so nothing else has to be re-scoped — whereas a new token means re-checking that it is **Object Read
& Write**, limited to the one bucket, and then remembering to delete the old one. (A brand-new token
is the right move only when you are replacing a *differently* scoped one.)

Cloudflare then shows the three values [described below](#the-three-values-cloudflare-shows-you),
once. **Leave that page open until step 3 reports success.** The old credential is already dead at
this point: every backup between here and a completed publish will fail.

**2. `--dry-run` first.** It runs the mate and connect checks and writes nothing anywhere, so a
mis-paste costs a retype rather than a broken escrow:

```bash
PROFILE=… npm run roll-r2 -- --vault <vault> --bucket <bucket> --account-id <cf-account> --dry-run
```

**3. Run it for real** — same command without `--dry-run`, plus `--repo owner/name`. It prompts for
three values, input hidden:

| prompt | paste |
|---|---|
| `Token value` | the token value |
| `Access Key ID` | the token's id |
| `Secret Access Key (blank = derive it)` | the secret — **or leave it blank** and the tool computes `SHA-256(token value)` itself |

Leaving the third blank is not a shortcut, it is a different trade: you skip the mate check (there
is nothing independent left to compare against) in exchange for removing the chance of pasting the
secret of a *different* token. Paste it when you have it.

`--account-id` is the Cloudflare account id — the same value as the `R2_ACCOUNT_ID` secret. You
cannot read that back out of GitHub, so take it from the escrow item in 1Password, or from the R2
endpoint URL `https://<account-id>.r2.cloudflarestorage.com`.

**4. Prove it landed.** The tool asserts the GitHub `updatedAt` timestamps moved, but that only says
*something* was written:

```bash
gh secret list --repo <owner/name> | grep R2_     # both should show today
gh workflow run pg-backup.yml --repo <owner/name> -f reason=manual
```

A manual backup is the cheap proof: it lands in the `intraday` tier only, which expires in 2 days, so
a bad roll costs nothing and you learn within minutes instead of at the next anchor. The rotation
record shows up in the following `verify-durable` run as `credential R2: rotated 0d ago`.

It does the checks in the order that fails cheapest, and writes nothing until they pass:

| | |
|---|---|
| **1. Mate** | `SHA-256(token value)` must equal the Secret Access Key you were shown. Halves of two different tokens is otherwise a silent failure deferred to the next backup. |
| **2. Connect** | the credential must actually list the bucket — **before** anything is stored. A credential proven at rest is not a credential proven to work. |
| **3. Escrow** | write 1Password, then read it **back** and compare bytes. |
| **4. Publish** | set the GitHub secrets from what 1Password returned, never from the paste buffer, and assert the `updatedAt` timestamps moved. |

Two flags carry real meaning rather than convenience:

- **`--repo` is optional.** An operator credential (a read-only token for DR listing) must never
  reach CI, so "escrow without publishing" is a first-class mode rather than a step you remember
  not to run.
- **`--dry-run`** runs the mate and connect checks and writes nothing anywhere. It answers "is this
  credential any good?" without a vault, and it is how the guards themselves are tested.

### Knowing when a rotation is overdue

After publishing with `--repo`, `roll-r2-token.ts` attempts to record the rotation in the
credential's own bucket (`_log/<name>/credentials-YYYY-MM.jsonl`,
holding no secret — the key-id tail is four characters). That record is the only durable trace a
rotation happened: a GitHub secret cannot be read back, and listing repository secrets needs a token
more privileged than the job that would do the checking.

From it, two read-outs:

- **daily**, in `verify-durable`: one line per tracked credential, and a Slack note when any is
  overdue. Never a failure — an ageing token cannot corrupt a backup.
- **on demand**: `npm run doctor -- verify-durable`, as an optional ⚠ check.

**This is ON by default — `credential-rotation:` tunes it, it does not enable it.** `track` defaults
to `["R2"]` and `max-age-days` to 365, so a profile with no `credential-rotation:` block at all is
still age-checking its R2 credential. That is deliberate (a check nobody opted into is the only kind
that catches the deployment nobody is looking after), but it does mean the first sign of it is
usually a Slack line on a profile whose author never configured anything. Set `max-age-days: 0` to
turn it off.

The rule that makes it worth running: **absence is not health**. A tracked credential with no
recorded rotation reports `unknown`, and `unknown` is grouped with `due`, not with `ok` — otherwise
the check would be loudest about the credentials someone is already looking after and silent about
the one that has sat untouched since the day it was minted.

#### `never recorded` — read this before you re-roll

```
credential rotation: R2: never recorded — rotate it with roll-r2-token.ts so its age is known
```

That line means **no rotation record exists**, which is not the same as **no rotation happened**.
Two quite different situations produce it, and only one of them wants a roll:

| | what happened | what to do |
|---|---|---|
| **Never rolled through the tool** | the token was minted by hand, or pre-dates `roll-r2-token.ts` | roll it — you also gain the escrow, which is the bigger win |
| **Rolled, but the record did not land** | escrow and publish succeeded; the run-log append failed (R2 unreachable, `PROFILE` unset, a missing profile `name`) and the tool warned | **do not re-roll.** The credential is fine. Re-rolling to fix bookkeeping destroys a working credential to quiet a log line |

Tell them apart before acting: `gh secret list --repo <owner/name> | grep R2_` shows when the
secrets were last *written*. A recent timestamp with no record is the second row. It is not proof —
setting a secret to the same value also moves the timestamp — but a timestamp from years ago is
good evidence of the first.

The record is a plain JSONL line in the credential's own bucket
(`_log/<name>/credentials-YYYY-MM.jsonl`), so the second row can also be closed by appending one by
hand rather than rotating. Recording is best-effort by design: a logging hiccup must never fail the
rotation it is describing, which is exactly why this state exists at all.

### The three values Cloudflare shows you

Only two are independent ([R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)):

| value | what it is |
|---|---|
| **Token value** | the credential itself, shown once on create or roll |
| **Access Key ID** | the token's `id` — a roll reissues the *value*, so this survives a roll |
| **Secret Access Key** | `SHA-256(token value)`, hex |

Two consequences the dashboard does not spell out. The **token value is strictly more recoverable
than the secret** — keep it and the secret can always be recomputed, so escrowing only the secret
throws information away. And the derivation gives a **free mate check**, the same shape as
`age-keygen -y` proving an age identity is the mate of its recipient.

