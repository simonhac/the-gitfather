# Verifying backups and restoring for real

## Verifying backups (integrity)

"A backup you've never restored is a hope, not a backup." Integrity is checked at three points, so
**every durable file is proven recoverable**, not just the newest one.

**1. At backup time** (`backup-pg-to-r2.ts`) — before a dump is declared good:

The dump is written as **plaintext first and encrypted afterwards**, so everything below reads it
with no decrypt key involved, whatever `encryption:` says. That ordering is deliberate and it is
what lets `AGE_IDENTITY` stay out of CI entirely: verification placed *after* encryption can only be
done by decrypting, which is how the identity ends up as a CI secret in the first place.

- **`dump.min-bytes`** floor — a suspiciously small dump is never uploaded.
- **`integrity.check-structure`** (default on) — `pg_restore -l` lists the archive's TOC; a corrupt or
  truncated dump above the size floor can't be listed and is rejected *before* it's reported as a success.
  Runs on the plaintext, so it applies to **every** encryption mode.
- **`integrity.verify-before-encrypt`** (opt-in, off by default) — a full `pg_restore` of the plaintext
  into `DRILL_DATABASE_URL` plus the `drill.*` row gates, on **every run**. The strongest proof there
  is, and it needs no key. Unlike the drill it covers every dump rather than only the promoted ones,
  so a dump that never becomes a durable copy is still verified. Costs one restore per run; the
  step's own wall time is logged (`durationMs` on the verification record) so the cost is measurable.
  Records a **`pre-encrypt`** verification — never a `restore`, because the object it proves is the
  dump, not the ciphertext that ends up in the bucket.
- **`integrity.checksum`** (default on) — a streaming SHA-256 of the exact uploaded bytes (ciphertext for
  age) is recorded in the run-log; it's the baseline the durable hash-check compares against.
- **`integrity.verify-after-upload`** (opt-in, off by default) — after upload, re-download the object,
  confirm its SHA-256 matches, and `pg_restore -l` it. Under `encryption: age` this needs `AGE_IDENTITY`
  in the backup job, so prefer `verify-before-encrypt`, which proves more and needs nothing.
- **`expect-recipient`** (opt-in) — the recipient `AGE_RECIPIENT` must equal, pinned in the profile.
  An age header carries an ephemeral share, **not** the recipient's public key, so no later check can
  tell you what an object was encrypted to. Without the pin, a rotated or mistyped secret writes
  objects nobody can open and nothing notices until someone tries to decrypt one.

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
- **`verify-durable.keyless`** (opt-in) reduces this job to the hash checks alone: no `AGE_IDENTITY`,
  no database, no restores. Pair it with `integrity.verify-before-encrypt` and the manual drill below.
  It is a **declaration**, not something inferred from a missing key — a profile that means to decrypt
  and has lost its identity must fail loudly rather than quietly become a hash-only check that still
  reports success. It refuses an identity in its environment for the same reason: a key this job has
  said it cannot use is a live secret nobody is watching.
- **`verify-durable.rehash-per-run`** (default 1): re-hash the N **least-recently-hashed** objects
  every run, on top of hashing each new one on first sight. Without it a stored object is
  byte-checked exactly once in its life — tolerable only while the aged restore leg was the
  recurring proof. One per run is a single download and sweeps a ~46-object corpus in ~46 days,
  and because it picks the oldest first, the budget lands on the long-lived `weekly`/`monthly`
  copies by itself: a `daily` copy expires before its turn ever comes round.
- **`verify-durable.rehash-max-age-days`** (default 90, 0 disables) **pages** when the
  least-recently-hashed object exceeds it. A rotation that stops — set to 0, or outgrown by the
  corpus — otherwise decays coverage with no symptom at all. Set it to roughly twice your sweep.
- **Census floor** (always on): the durable listing is checked against the run-log, which independently
  records every promotion and the retention window it is still inside. Anything the log names that the
  listing did not return **pages**, naming the keys. A filtered listing cannot otherwise tell "nothing is
  due" apart from "I could not see it" — and it got that wrong once, the day a profile switched
  `encryption: none → age`: the enumeration filtered on the *currently configured* extension, so every
  pre-switch `.dump` object went invisible and the run reported green having verified 1 object of 35.
  Selection now matches **any** dump generation (`.dump`, `.dump.age`, `.dump.enc`), because a bucket
  legitimately holds both for a whole retention window after the setting changes.

**4. The manual drill** (`drill-object.ts`, `npm run drill-object`) — the one thing no automated job
can do once the identity is offline: prove an object **in the bucket** still opens with the escrowed
key, and restores.

```bash
PROFILE=… npm run drill-object -- --list                  # what is there
AGE_IDENTITY="$(op read 'op://<vault>/<item>/AGE_IDENTITY')" \
  PROFILE=… npm run drill-object -- --key monthly/<name>-<stamp>.dump.age
```

It records a `kind: "restore"`, `by: "manual"` verification, which is what lights the dashboard's
**bright** cell — nothing automated sets that any more, so bright green means a person decrypted and
restored that exact object. It needs no `PG_LIVE_DATABASE_URL`: the default `nonempty` gate does not
compare against a live table, so a routine drill never hands production credentials to a laptop.

> Read the identity with **`op read`** (or `--format=json`). The plain `op item get --fields` form
> wraps a MULTI-LINE value in literal double quotes, and age then rejects it with
> `unknown identity type: "# created: …`.

Net, with restores enabled: **weekly/monthly are validated three times or more** (hash on write +
restore at ~2 weeks + a re-hash roughly every sweep thereafter), **daily twice** (hash on write, plus
the primary restore when it is the freshest). Because that primary restore covers the freshest dump
every day, this **supersedes the weekly `pg-restore-drill.yml`** — wire `pg-durable-verify.yml` and
drop the weekly drill.

Net, **keyless**: the restore legs are gone, so the ladder is hash on write + a re-hash every sweep,
with restorability proved at backup time by `integrity.verify-before-encrypt` and decryptability by
the manual drill. Strictly fewer *kinds* of check in this job, but more coverage overall — the
pre-encrypt restore tests **every** dump rather than only the promoted ones.

Every drill — pass **or fail** — is recorded to the verifications log, so a failed restore shows up: on
the dashboard as an **amber "Drill failed"** cell (distinct from a red *failed backup*), and as a loud
Slack/`ALERT_WEBHOOK_URL` page. The hash-vs-restore distinction drives the tooltip wording.


> **`verify-after-upload` and age.** `integrity.verify-after-upload` re-downloads and `pg_restore -l`s
> the object it just wrote. With `encryption: age` that means the **backup** job must be able to
> decrypt, i.e. it needs `AGE_IDENTITY` — and the reusable `pg-backup.yml` deliberately does *not*
> declare that secret. Use **`verify-before-encrypt`** instead: it restores the same dump, proves
> strictly more (real rows, not just a listable TOC), covers every run rather than only the promoted
> ones, and needs no key at all because it runs before the bytes are encrypted.

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
