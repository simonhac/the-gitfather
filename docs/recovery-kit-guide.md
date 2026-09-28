# Recovery kit guide: restoring, and the monthly check

This is the practical guide to the recovery kit. It covers the full-restore runbook, the monthly
check, and keeping the kit current. For what the kit is and how it works, see [the recovery kit: how
it works](recovery-kit.md).

**In one paragraph.** Each backup bucket holds, under `recovery-kit/<kit-id>/`, everything needed to
open its backups with no internet: the SLIP-39 code the key cards need, age, zstd, and PostgreSQL's
source. The kit's `README.md` is written for a stranger who has never seen this repo. The monthly
manual drill builds its tools from that kit, so the kit is proved every month, not just stored.

## What you need, in any recovery

| | Where it normally lives | If that is gone |
|---|---|---|
| **Read access to the bucket** | The R2 credential in 1Password (`op://<project>-prod/backup/R2_*`), or a login to the Cloudflare account | Nothing in the kit replaces this. Keep a read-only operator credential somewhere other than 1Password. |
| **The age identity** (one for dumps; archives have their own) | 1Password (`AGE_IDENTITY`, `AGE_ARCHIVE_IDENTITY`) | Any two of the three key holders' cards: [rebuild it](key-escrow.md#recovering-a-key) |
| **age, `pg_restore`, zstd** | Installed on your machine | The recovery kit in the bucket, or the USB copy |
| **A PostgreSQL to restore into** | Your platform (e.g. a fresh project on the same provider) | The kit builds one locally |

---

## Runbook: full restore

Use this when the production database is lost or corrupted and you need it back from a backup. Work
through it in order and write down what you did as you go. Allow an hour, plus the time to reach two
key holders if the identity has to be rebuilt.

### 1. Decide what to restore, and where

- **Which backup.** Usually the newest dump from before the damage. The tiers are
  `<prefix>/intraday/` (the last 2 days, several a day), `daily/` (3 weeks), `weekly/` (13 weeks) and
  `monthly/` (up to 2 years). The object name carries its UTC time:
  `<name>-<YYYYMMDDTHHMMSSZ>.dump.age`. If the damage went unnoticed for a while, pick a dump from
  before it started, not the newest one.
- **Where.** Restore into a **new, empty** database, never over the damaged one. For a faithful
  recovery, use the same platform and major version as production (for example, a fresh project with
  the same provider). You can repoint the application once the restore checks out.

### 2. Get the backup

Any S3 client works. With rclone and the bucket's credentials:

```bash
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="$(op read op://<project>-prod/backup/R2_ACCESS_KEY_ID)" \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$(op read op://<project>-prod/backup/R2_SECRET_ACCESS_KEY)" \
  RCLONE_CONFIG_R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
rclone lsf r2:<bucket>/<prefix>/daily/                    # pick the object
rclone copyto r2:<bucket>/<prefix>/daily/<object>.dump.age ./backup.dump.age
```

With the repo to hand, `PROFILE=… npm run drill-object -- --list` lists every tier's objects.

### 3. Get the key

- **From 1Password:** `op read op://<project>-prod/backup/AGE_IDENTITY > identity.txt`
- **From the cards,** if the vault is gone: two holders read out their words. They don't need to be
  together or available at the same time.
  - **With this repo:** use `npm run key-shares -- check-share` and `recover`
    ([Recovering a key](key-escrow.md#recovering-a-key)).
  - **Without it:** follow step 2 of the kit's `README.md` (below).

Either way, check the key before using it: `age-keygen -y identity.txt` must print the recipient on
the card (its **Unlocks** code), or the profile's `expect-recipient` (also `AGE_RECIPIENT` in 1Password).

`identity.txt` is the key to every backup. Keep it on this one machine, and delete it when you are
done.

### 4. Get the tools

If your machine already has age and a `pg_restore` at least as new as the dumps' major (17 unless the
profile's `dump.client-major` says otherwise), use them and skip to step 5. Otherwise, use the kit:

```bash
rclone lsf --dirs-only r2:<bucket>/recovery-kit/          # kits are named <date>-<digest>; take the newest
rclone copy r2:<bucket>/recovery-kit/<kit-id>/ ./kit/
cd kit && shasum -a 256 -c SHA256SUMS                     # every line must say OK
bash build-tools.sh "$HOME/kit-tools"                     # about 5 minutes; needs a C compiler, make, Perl
export PATH="$HOME/kit-tools/bin:$PATH"
```

No R2 at all? The USB copy is the same kit as one `.tar` file: `tar xf <kit>.tar`, `cd` into the
folder it makes, then carry on from `shasum`. The kit's own `README.md` covers the same steps, for
someone without this guide.

### 5. Decrypt and restore

```bash
age -d -i identity.txt backup.dump.age > backup.dump
pg_restore -l backup.dump | head                          # a readable table of contents: the dump is intact

# Into the new database. A local scratch server needs no SSL:
#   initdb -D "$HOME/pgdata" -U postgres && pg_ctl -D "$HOME/pgdata" -l pg.log start
#   createdb -U postgres restored
pg_restore --no-owner --no-privileges --disable-triggers -j4 -d '<target connection URL>' backup.dump
```

`--disable-triggers` avoids foreign-key ordering problems, but needs a superuser on the target.
Provider-managed schemas may raise warnings in a vanilla PostgreSQL; restoring into the same platform
avoids that. The kit's `pg_restore` is built **without SSL**. For a hosted target that requires SSL,
use a `pg_restore` of the same major from the provider or your OS.

### 6. Check it before switching over

- Row counts of the tables that matter look right against what you expect. The dump-time counts of
  the sentinel table are in the run-log, in `_log/<name>/runs-*.jsonl`.
- The newest rows are from about the time of the backup.
- The application works against the restored database in a staging setup.

Then repoint the application.

### 7. Afterwards

- Delete `identity.txt`, `backup.dump` and any scratch database: each holds either the key or a copy
  of production.
- **If the key was rebuilt from cards,** it has now existed on a laptop. Decide whether to rotate it
  ([When holders change](key-escrow.md#when-holders-change-or-a-card-is-lost)).
- Table archives, if the project uses them, open the same way with the **archive** identity:
  `age -d -i archive-identity.txt <file>.ndjson.zst.age | zstd -d > rows.ndjson`.
- Write up what happened, including anything in this runbook that was wrong or missing, and fix it.

---

## Runbook: the monthly check

This proves, every month, that a real object in the bucket still opens with the escrowed key, restores,
and that the stored recovery kit still builds the tools to do it. It takes about 15 minutes, plus
about 5 the first time a new kit is used. Do it for each project; set
`verify-durable.drill-max-age-days` (e.g. `45`) in the profile so you get a warning when a month
is missed.

**You need** this repo, rclone, a C compiler with `make` and Perl, a local PostgreSQL server to
restore into (any major at least the dumps'), and the project's 1Password vault.

### 1. Check every stored kit

```bash
export R2_ACCOUNT_ID="$(op read op://<project>-prod/backup/R2_ACCOUNT_ID)" R2_BUCKET=<bucket> \
  R2_ACCESS_KEY_ID="$(op read op://<project>-prod/backup/R2_ACCESS_KEY_ID)" \
  R2_SECRET_ACCESS_KEY="$(op read op://<project>-prod/backup/R2_SECRET_ACCESS_KEY)"
npm run recovery-kit -- verify
```

Every kit should say `every file matches its SHA256SUMS`, and the newest should say `(current)`. If a
kit is **DAMAGED**, or none is **current**, follow [Updating the kit](#updating-the-kit) before going
on.

### 2. Choose the object

Take the newest **encrypted** `monthly/` object (`.dump.age`). Just after a project switches to
`encryption: age`, the monthly tier stays plaintext until the 1st of the next month, so drill the
newest encrypted `weekly/` object until then. A plaintext `.dump` restores without the key, so it
proves nothing about the key.

```bash
PROFILE=path/to/profile.yaml npm run drill-object -- --list
```

### 3. Run the drill

```bash
PROFILE=path/to/profile.yaml \
AGE_IDENTITY="$(op read op://<project>-prod/backup/AGE_IDENTITY)" \
DRILL_DATABASE_URL='postgresql://<you>@localhost/postgres?host=/tmp&sslmode=disable' \
  npm run drill-object -- --key monthly/<name>-<stamp>.dump.age
```

It uses the `R2_*` variables from step 1. Read the identity with `op read`: `op item get --fields`
wraps a multi-line value in quotes, and age then rejects it. The drill:
1. fetches the newest complete kit and checks every byte;
2. builds its tools, or reuses them from the cache;
3. decrypts the object with those tools and restores it into a `gitfather_drill` database on your
   local server;
4. records the result, with the kit's id, in the run-log.

A pass ends with:

```
✓ restore-verified <prefix>/monthly/<object> in <n>s, with recovery kit <kit-id>'s tools
```

That lights the dashboard's bright cell for the object, and resets the overdue-drill warning.

### 4. Clean up and log it

```bash
psql -h /tmp -d postgres -c 'DROP DATABASE gitfather_drill'   # it holds a copy of production
```

Note the date, the object, the kit id, the row counts the drill printed and how long it took in the
project's private drill log. That history outlives the run-log's retention.

### If it fails

| Message | What it means | Do |
|---|---|---|
| `no complete recovery kit is stored` | This bucket has no kit, or only a cut-short upload | [Updating the kit](#updating-the-kit), then re-run |
| `the stored kit … is DAMAGED` | A kit object no longer matches its checksum | Upload a fresh kit (it gets a new id), then investigate: the lock should have made this impossible |
| `build-tools.sh failed` | The stored kit cannot build its own tools on this machine | Look at the log it names. A missing compiler is your machine; anything else is a gap in the kit, so fix the manifest and run the offline drill. |
| `note: this kit predates the manifest` | The drill still runs, on an older kit | Upload a current kit afterwards |
| A decrypt error | The identity does not open this object | Treat it as serious. Check `age-keygen -y` against the profile's recipient, and try another object. If the escrowed key really does not open the backups, stop and escalate. |
| A restore error or row-count failure | The object restores badly | Try the previous monthly, and check the automated durable-verify results for the same object |

---

## Updating the kit

Rebuild and re-upload a kit when:
- the manifest changes (a version bump, or PostgreSQL's major moving with `dump.client-major`);
- `docs/key-escrow.md` changes (the kit carries a copy);
- `verify` reports a kit damaged.

```bash
npm run recovery-kit -- build --out ~/recovery-kit          # also writes ~/recovery-kit.tar
npm run key-shares -- drill --kit ~/recovery-kit            # offline proof; needs Docker; ~5 min
# then, for each bucket, with its R2_* variables set as in the monthly check:
npm run recovery-kit -- upload --kit ~/recovery-kit        # stores and re-verifies it
```

Uploading a kit that is already stored does nothing, and a cut-short upload resumes, so it is always
safe to re-run. Older kits stay in the bucket; the monthly drill uses the newest.

**A new bucket** also needs the one-time lock, with account-level Cloudflare credentials:
[R2 setup](r2-setup.md#the-recovery-kit-prefix).

**The USB copy.** Copy `~/recovery-kit.tar` to a USB drive and give it to one of the key holders.
Replace it when the kit changes. It holds no secret.

**Once a year,** alongside the key holders' check-in ([key escrow](key-escrow.md#when-holders-change-or-a-card-is-lost)),
run the offline drill against a freshly built kit.
