# Verifying backups and restoring for real

## Verifying backups (integrity)

"A backup you've never restored is a hope, not a backup." Integrity is checked at three points, so
**every durable file is proven recoverable**, not just the newest one.

**1. At backup time** (`backup-pg-to-r2.ts`) — before a dump is declared good:

- **`dump.min-bytes`** floor — a suspiciously small dump is never uploaded.
- **`integrity.check-structure`** (default on) — `pg_restore -l` lists the archive's TOC; a corrupt or
  truncated dump above the size floor can't be listed and is rejected *before* it's reported as a success.
  (For `encryption: none`; age dumps are validated by the drill / by `integrity.verify-after-upload`.)
- **`integrity.checksum`** (default on) — a streaming SHA-256 of the exact uploaded bytes (ciphertext for
  age) is recorded in the run-log; it's the baseline the durable hash-check compares against.
- **`integrity.verify-after-upload`** (opt-in, off by default) — after upload, re-download the object,
  confirm its SHA-256 matches, and `pg_restore -l` it. This is the only *backup-time* structural check for
  age (it needs `AGE_IDENTITY` in the backup job to decrypt). Costs a re-download per run, so it's opt-in.

**2. The restore drill** (`restore-drill-pg.ts`) — restores the newest `2hourly` dump into a throwaway
Postgres and gates on the data, not just a clean exit:

- The `drill.row-count-table` count must be **`drill.min-row-ratio` ≤ restored/live ≤ `drill.max-row-ratio`**
  (catches truncation *and* duplication; live is `n_live_tup`, an estimate).
- **`drill.present-tables`** must each exist in the restore; **`drill.nonempty-tables`** must each exist
  *and* be non-empty (catches a partial-schema restore).
- `pg_restore` stderr is **classified**: known managed-schema noise (missing roles/extensions, ownership,
  idempotent "already exists") is tolerated; any *unrecognised* error fails the drill.
- **`drill.max-row-drop`** (optional, off by default) fails the drill if a table shrank more than the
  given fraction vs the previous passing drill.

**3. Daily durable verification** (`verify-durable-pg.ts`, the `pg-durable-verify.yml` workflow) —
guarantees **every** `daily`/`weekly`/`monthly` object is tested, driven by the verifications log so a
missed run self-corrects:

- **`verify-durable.fresh`** (default on): on first sight, hash-check each durable object against its
  recorded SHA-256 (proves the server-side copy is byte-intact), and full-restore the freshest `daily`.
- **`verify-durable.aged`** (default on): full-restore the newest `weekly`/`monthly` object **≥
  `verify-durable.retest-days` (14)** old not yet restore-verified (the aged-copy proof, just inside the WORM lock).
- **`verify-durable.max-restores`** caps full restores per run (hash-checks are uncapped — cheap).
- **Census floor** (always on): the durable listing is checked against the run-log, which independently
  records every promotion and the retention window it is still inside. Anything the log names that the
  listing did not return **pages**, naming the keys. A filtered listing cannot otherwise tell "nothing is
  due" apart from "I could not see it" — and it got that wrong once, the day a profile switched
  `encryption: none → age`: the enumeration filtered on the *currently configured* extension, so every
  pre-switch `.dump` object went invisible and the run reported green having verified 1 object of 35.
  Selection now matches **any** dump generation (`.dump`, `.dump.age`, `.dump.enc`), because a bucket
  legitimately holds both for a whole retention window after the setting changes.

Net: **weekly/monthly are validated twice** (hash on write + restore at ~2 weeks), **daily once** (it's
the short-lived 3-week tier). Because the daily primary restore covers the freshest dump every day, this
**supersedes the weekly `pg-restore-drill.yml`** — wire `pg-durable-verify.yml` and drop the weekly drill.

Every drill — pass **or fail** — is recorded to the verifications log, so a failed restore shows up: on
the dashboard as an **amber "Drill failed"** cell (distinct from a red *failed backup*), and as a loud
Slack/`ALERT_WEBHOOK_URL` page. The hash-vs-restore distinction drives the tooltip wording.


> **`verify-after-upload` and age.** `integrity.verify-after-upload` re-downloads and `pg_restore -l`s
> the object it just wrote. With `encryption: age` that means the **backup** job must be able to
> decrypt, i.e. it needs `AGE_IDENTITY` — and the reusable `pg-backup.yml` deliberately does *not*
> declare that secret. So on an age-encrypted profile, leave `verify-after-upload: false` and let the
> daily durable verify (which does hold `AGE_IDENTITY`) be the structural proof.

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
