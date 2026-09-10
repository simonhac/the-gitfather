# R2 buckets, retention, locks and tokens

Everything the-gitfather stores lives in **one private R2 bucket** (plus a separate public bucket for
the [dashboard](dashboard.md)). Retention and immutability are enforced by **R2 lifecycle rules and
bucket locks**, not by the scripts — so this page is the one you follow once, per bucket, with
account-level Cloudflare credentials.

## Backup tiers (GFS + a finer "grandson" tier)

| Tier | Label | Cadence | R2 prefix | Lifecycle expiry (default) | Bucket lock |
|---|---|---|---|---|---|
| 8-hourly | grandson | every 8 h | `<prefix>/2hourly/` | 2 days | none |
| daily | Son | anchor hour | `<prefix>/daily/` | 3 weeks | 14 days |
| weekly | Father | Sundays @ anchor | `<prefix>/weekly/` | 13 weeks | 14 days |
| monthly | Grandfather | 1st @ anchor | `<prefix>/monthly/` | 2 years | 14 days |

`2hourly/` is a **frozen legacy key prefix**, not a cadence: the finest tier runs 8-hourly (the
`staleness.slot-minutes` default of `480`), but the object-key prefix keeps its original name so
existing buckets stay readable. Key and label diverge on purpose (`scripts/lib/backupTypes.ts`) — the
dashboard and Slack render the real cadence.

The expiry windows are the **profile's `retention:` block** (natural-language durations — see the
[profile reference](configuration-and-troubleshooting.md#profile-reference)); the values above are the
defaults. At most ~82 backups are retained at once. **These windows
are also what the dashboard renders, but R2 itself does the deleting** via the lifecycle rules below —
keep the two in sync (changing the profile does not reconfigure R2).

**One dump, promoted to all qualifying tiers.** Each run dumps once and uploads to `2hourly/`. The run
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
npx wrangler r2 bucket lifecycle add <your-bucket> expire-2hourly <prefix>/2hourly/ --expire-days 2
npx wrangler r2 bucket lifecycle add <your-bucket> expire-daily   <prefix>/daily/   --expire-days 21
npx wrangler r2 bucket lifecycle add <your-bucket> expire-weekly  <prefix>/weekly/  --expire-days 91
npx wrangler r2 bucket lifecycle add <your-bucket> expire-monthly <prefix>/monthly/ --expire-days 730
npx wrangler r2 bucket lifecycle add <your-bucket> abort-mpu      <prefix>/         --abort-multipart-days 1
npx wrangler r2 bucket lifecycle add <your-bucket> expire-status  _status/          --expire-days 14
npx wrangler r2 bucket lifecycle add <your-bucket> expire-log     _log/             --expire-days 760
# _config/ (the watchdog config the backup publishes for the Worker) is overwritten every run and must
# NOT be locked or expired — like _status/, it is control-plane state, not a backup.

# Bucket locks (WORM): 14-day immutability on the DURABLE tiers only — NOT on 2hourly/ (a lock there
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

## Rotating an R2 token — `npm run roll-r2`

Rolling an R2 API token is the only way to **learn** its credential: neither Cloudflare nor GitHub
will show you an existing one again. So the roll is simultaneously the one moment escrow is
possible and the one moment it is easy to get wrong — the old credential dies immediately, the new
one is displayed once, and nothing downstream can be read back to check what you stored.

```bash
npm run roll-r2 -- --vault <1password-vault> --bucket <r2-bucket> --account-id <cf-account> \
  [--prefix R2] [--repo owner/name] [--dry-run]
```

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

`roll-r2-token.ts` records each rotation into the run-log (`_log/<name>/credentials-YYYY-MM.jsonl`,
holding no secret — the key-id tail is four characters). That record is the only durable trace a
rotation happened: a GitHub secret cannot be read back, and listing repository secrets needs a token
more privileged than the job that would do the checking.

From it, two read-outs — configure with `credential-rotation:` in the profile:

- **daily**, in `verify-durable`: one line per tracked credential, and a Slack note when any is
  overdue. Never a failure — an ageing token cannot corrupt a backup.
- **on demand**: `npm run doctor -- verify-durable`, as an optional ⚠ check.

The rule that makes it worth running: **absence is not health**. A tracked credential with no
recorded rotation reports `unknown`, and `unknown` is grouped with `due`, not with `ok` — otherwise
the check would be loudest about the credentials someone is already looking after and silent about
the one that has sat untouched since the day it was minted.

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

