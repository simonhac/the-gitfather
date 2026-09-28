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

**2. The restore drill** (`restore-drill-pg.ts`) — restores the newest `intraday` dump into a throwaway
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
- **`verify-durable.rehash-max-age-days`** (**default 0 — off**) **pages** when the
  least-recently-hashed object exceeds it. A rotation that stops, or one outgrown by the corpus,
  otherwise decays coverage with no symptom at all. Set it to roughly twice your sweep, and turn it
  on only **after** the rotation has swept once: beforehand each object carries a single hash from
  the day it was promoted, so the backlog spans your whole corpus's age and this pages every night
  for a sweep. Unlike `rehash-per-run`, defaulting this on would fire an alarm on a condition the
  feature itself introduced.
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

It runs on the **recovery kit's tools**, not the laptop's: it downloads the newest complete kit from
the bucket (or `--kit-id <id>`), checks every byte, builds the kit's age, `pg_restore` and `psql`, and
puts them first on `PATH` ([why](key-escrow.md#the-monthly-drill-runs-on-the-kit)). So each drill also
proves the stored kit still works. The first drill on a new kit takes a few extra minutes to build; the
tools are cached per kit after that. With no kit stored, the drill refuses to run.

It records a `kind: "restore"`, `by: "manual"` verification, naming the kit, which is what lights the dashboard's
**bright** cell — nothing automated sets that any more, so bright green means a person decrypted and
restored that exact object. It needs no `PG_LIVE_DATABASE_URL`: the default `nonempty` gate does not
compare against a live table, so a routine drill never hands production credentials to a laptop.

> Read the identity with **`op read`** (or `--format=json`). The plain `op item get --fields` form
> wraps a MULTI-LINE value in literal double quotes, and age then rejects it with
> `unknown identity type: "# created: …`.

**Running it — a monthly runbook.** Under `verify-durable.keyless` this drill is the *only* proof that
the escrowed identity still opens what is in the bucket, so give it a cadence and keep a log.
`verify-durable.drill-max-age-days` (set it a little above the cadence — e.g. 45 for monthly) makes
durable-verify post a quiet warning once the newest `by: manual` restore that ran on the recovery kit
is older than that, and "has NEVER been run with the recovery kit" until the first one is recorded.

1. **What to drill.** Prefer the newest **encrypted** durable copy — ideally the newest `monthly/`
   one. After `encryption: none → age`, the monthly tier stays plaintext until the first
   anchor-hour run on the 1st of the next month, so until then drill the newest encrypted
   `weekly/` object instead. A plaintext `.dump` restores without the identity (the drill prints
   "Fetched OK — a plaintext object"), so it proves the old generation still restores, not that the
   key works; drill one of those separately if you need that evidence too.
2. **Where it restores.** Any throwaway Postgres whose major is ≥ the dump's — a local server over its
   Unix socket is fine, e.g. `DRILL_DATABASE_URL='postgresql://<you>@localhost/postgres?host=/tmp&sslmode=disable'`.
   The kit's client is built without SSL, so use a local server, not a remote one.
   The drill drops and recreates a `gitfather_drill` database there and **leaves it** after the run;
   it holds a copy of production, so drop it when you are done
   (`psql -h /tmp -d postgres -c 'DROP DATABASE gitfather_drill'`).
3. **Credentials.** The R2 variables for the bucket (read, plus write under `_log/` to record the
   result) and `AGE_IDENTITY` for an `.age` object — each read straight from your secret manager into
   the command, never written to disk:
   ```bash
   PROFILE=path/to/profile.yaml \
   R2_ACCOUNT_ID="$(op read op://<vault>/<item>/R2_ACCOUNT_ID)" R2_BUCKET="$(op read op://<vault>/<item>/R2_BUCKET)" \
   R2_ACCESS_KEY_ID="$(op read op://<vault>/<item>/R2_ACCESS_KEY_ID)" R2_SECRET_ACCESS_KEY="$(op read op://<vault>/<item>/R2_SECRET_ACCESS_KEY)" \
   AGE_IDENTITY="$(op read op://<vault>/<item>/AGE_IDENTITY)" \
   DRILL_DATABASE_URL='postgresql://<you>@localhost/postgres?host=/tmp&sslmode=disable' \
     npm run drill-object -- --key weekly/<name>-<stamp>.dump.age
   ```
4. **Record it.** The run-log record is automatic; also note the object key, the date, the row counts
   the drill prints and its time in the project's own (private) drill log, so the history survives the
   run-log's retention and a human can see the cadence being kept.

Net, with restores enabled: **weekly/monthly are validated three times or more** (hash on write +
restore at ~2 weeks + a re-hash roughly every sweep thereafter), **daily twice** (hash on write, plus
the primary restore when it is the freshest). Because that primary restore covers the freshest dump
every day, this **supersedes the weekly `pg-restore-drill.yml`** — wire `pg-durable-verify.yml` and
drop the weekly drill.

Net, **keyless**: the restore legs are gone, so the ladder is hash on write + a re-hash every sweep,
with restorability proved at backup time by `integrity.verify-before-encrypt` and decryptability by
the manual drill. Strictly fewer *kinds* of check in this job, but more coverage overall — the
pre-encrypt restore tests **every** dump rather than only the promoted ones.

Every drill — pass **or fail** — is recorded to the verifications log, so a failed restore shows up
in two places. On the dashboard it is an **amber "Drill failed"** cell, distinct from a red *failed
backup*; the hash-vs-restore distinction drives the tooltip wording. In Slack it is a loud page.

The verify and drill jobs don't post to Slack themselves. Each run records its pages and warnings in
its outcome record, and the scheduler Worker posts them
([Slack and alerting](slack-and-alerting.md#what-posts-where)):
- **A failed durable verify** posts one mentioning message, with a bullet per problem.
- **Its advisory warnings** (a manual drill overdue, a credential due for rotation) post as one quiet
  ⚠️ message.
- **A restore drill** posts a ✅ notice with its row ratio, or a page.

Pages also go to the client's failure webhook (`ALERT_WEBHOOK_URL_<ID>` on the Worker), if it has
one.


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

If the identity for step 2 is gone with its vault, two of the three key holders can rebuild it — see
[Key escrow](key-escrow.md#recovering-a-key). If age or a new enough `pg_restore` is not to hand, the
[recovery kit](key-escrow.md#the-recovery-kit) in the same bucket (`recovery-kit/`) builds both offline.
