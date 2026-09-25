# Archiving a table out of Postgres

Backups copy; the **archiver moves**. `archive-table.ts` extracts rows older than N weeks from an
append-only table into one compressed, encrypted object per ISO week, and — as a separately gated
step — deletes those rows from the source. It is for the table that has outgrown its database: the
request log, the event log, the audit trail nobody queries but nobody wants to lose.

It is entirely optional and entirely profile-driven. Omit the `archive:` block and nothing changes.

```
<store-prefix>/<table>/2026/<name>-<table>-2026-W23-p001.ndjson.zst.age   # encrypted rows
<store-prefix>/<table>/2026/<name>-<table>-2026-W23-p001.manifest.json    # plaintext sidecar
<store-prefix>/<table>/_index/<table>-2026.jsonl                          # derived cache
```

Weeks are ISO-8601 on **UTC** boundaries, half-open `[Mon 00:00Z, next Mon 00:00Z)`, so they tile the
timeline with no gap and no overlap. The folder is the ISO *week-numbering* year, which is why
`2026-W01` files under `2026/` even though it begins on 29 December 2025 — label and folder can never
disagree. A week eligible but **empty** still gets a manifest (`rowCount: 0`, no data object), so a gap
in the archive is explained rather than mysterious.

### Why prune is a separate phase

A week is deleted only after its object has been re-downloaded and its SHA-256 re-checked, **and** only
if the live row set still matches what was archived. That match is a fingerprint — `count(*)` plus an
order-independent 64-bit XOR of `md5(id)` — that Postgres and Node compute identically:

```sql
bit_xor(('x' || substr(md5(id::text), 1, 16))::bit(64)::bigint)
```

The point of an XOR rather than a hash over sorted ids is that it needs no ordering and constant
memory — `string_agg` over millions of uuids would allocate hundreds of megabytes inside Postgres.
The deeper point is that **the gate never decrypts anything**, which is what lets the archive key stay
out of CI entirely (below).

Any drift refuses outright; nothing is ever partially deleted. The two ways drift can happen are
handled without set subtraction, because objects are additive parts and never rewritten:

| situation | what happens |
|---|---|
| rows changed between archive and prune | re-archive the full window as `p002`, mark `p001` superseded, prune against `p002` |
| rows appear in a week that was already pruned | archive them as a supplement part, and raise a loud alert — this should not happen |

### The floor: a run that owed work must do it

A run that archives nothing is usually healthy — nothing was eligible. That is exactly why a
*stalled* archiver is invisible: CB-264's ran every Sunday for weeks, archived nothing, and printed
`✓ done`. So every archive phase ends with a conditional floor (`archiveFloor` in `lib/archive.ts`):

```
backlog = eligible weeks the index has NEVER archived
owed    = min(backlog, max-weeks-per-run)
spent < owed  ⟹  "archive stalled" — an anomaly: it pages, marks the run-log record not-ok, exits 1
```

It tolerates the throttle (backlog 8, cap 1, one archived is progress) and never fires on an idle
run. The backlog is enumerated **independently** of the loop's candidate list — CB-264 was a bug in
how that list was built, and a floor derived from it read a backlog of 0 and passed the stall.

A real, clean archiving run then writes its **job proof**, `_health/<name>/archive.json`. A dry run,
a local target, a prune-only or `--rebuild-index` run doesn't write one, and neither does a run with
any failure, refusal or anomaly. The stall counts as an anomaly, so the proof means *"ran, and did the
work it owed"*, not just *"ran"*. The scheduler's `/health/jobs` goes red when the proof is more than
8 days old. See [slack-and-alerting.md](slack-and-alerting.md#job-proofs-one-monitor-for-every-job).

### The two levels of dry run

| flag | source database | store |
|---|---|---|
| `--dry-run=none` (default) | reads + deletes | writes |
| `--dry-run=source` | read-only, enforced with `SET default_transaction_read_only` | writes |
| `--dry-run=store` | read-only, enforced | nothing written; artifacts left in the work dir |

`store` implies `source`. That is a safety invariant, not a convenience: there is deliberately no
combination of flags that deletes rows without having written them. Orthogonally,
`--target=local:<dir>` performs **real** writes to a directory (refusing to overwrite, so it rehearses
WORM too) — run the whole pipeline there before pointing it at R2.

### Encryption: a different recipient from the dumps

`archive.encryption: age` uses **`AGE_ARCHIVE_RECIPIENT`**, not the dumps' `AGE_RECIPIENT`. Keep the
matching identity **offline** (a password manager, not a GitHub secret). CI never needs it: verification
is hash- and fingerprint-based, so a leaked CI credential can move archives around but cannot read a
single row.

Resist the temptation to reuse the dump recipient. CI legitimately holds *that* identity so
`verify-durable-pg.ts` can keep proving dumps restore — and a dump is regenerated every few hours, so
its confidentiality window is short. The archive is the opposite: irreplaceable, and often the most
sensitive thing you store. Different lifetimes, different trust domains, different keys.

### R2 setup for the archive prefix

The store prefix gets **no lifecycle expiry rule** and a 90-day lock — the inverse of the GFS tiers.
See [R2 buckets, retention, locks and tokens → The archive prefix](r2-setup.md#the-archive-prefix).

### Backfilling a legacy table

The first run against a table with years of history is the same code path, looped. Work it off in
batches, verify, and only then delete:

```bash
# 1. archive only — this NEVER deletes, so it is safe to repeat and safe to interrupt
npx tsx scripts/archive-table.ts --mode archive --max-weeks 8
# …repeat until it reports nothing eligible. It resumes from the manifests already in the store,
#    so there is no local state to lose.

# 2. spot-check: pull one object back and decrypt it with the offline identity
rclone cat r2:<bucket>/<key> | age -d -i identity.txt | zstd -d | head -1

# 3. then, and only then
npx tsx scripts/archive-table.ts --mode prune
```

Afterwards, run **`VACUUM FULL`** on the table once. A plain `DELETE` only marks space reusable — it
does not return it to the operating system — so without this the table stops growing but never shrinks.
It takes an `ACCESS EXCLUSIVE` lock, so size the window to the table: seconds for tens of megabytes,
rather longer for tens of gigabytes.

### Repairing the index

`_index/` is a materialised view of the manifests, so there are two ways to fix it — and they are
not interchangeable:

```bash
# Fill in `bytes` for weeks archived before that field existed. Sizes come from the objects
# themselves (one listing per table). Reports only; add --apply to write.
npx tsx scripts/backfill-archive-sizes.ts
npx tsx scripts/backfill-archive-sizes.ts --apply

# Re-derive the WHOLE index from the manifests — the recovery path for an index that is lost or wrong.
npx tsx scripts/archive-table.ts --rebuild-index
```

Reach for the **backfill** unless the index is actually broken. It never opens the database, only ever
*adds* a size to a part (each line is round-trip checked, and the original file is kept beside its
replacement as a timestamped `.bak-`), and cannot touch a week's archived/pruned state.

`--rebuild-index` discards the index and rebuilds it, which means re-deciding every week's state by
asking Postgres whether the window is empty. That is right for a lost index and too much for a missing
number: a week that was pruned but has since acquired a back-dated row reconciles back to `archived`,
and the next run then supersedes the real archive with those few stragglers.

Both are available in CI — `backfill_sizes: true` (plus `backfill_apply` when you mean it) on the
`pg-archive` workflow runs the first; the second has no input and is a local operation.

### Preflight

```bash
npm run doctor -- archive
```

Checks the config, that `psql` / `zstd` / `age` / `rclone` are present, that the archive database
credential connects, and that the bucket is reachable — before a single row moves.

### Running it in CI

The reusable `pg-archive.yml` workflow runs everything above from a thin caller in your repo — see
[Wiring a consuming repo](wiring-a-consuming-repo.md#2-add-the-caller-workflows-githubworkflows-in-your-repo) for
the full caller block. Its `workflow_dispatch` inputs map one-to-one onto the CLI flags:

| input | default | what it does |
|---|---|---|
| `mode` | `both` | `archive` (never deletes) · `prune` · `both` |
| `table` | `""` | restrict the run to one configured table |
| `max_weeks` | `""` | override the profile's `max-weeks-per-run` — the backfill throttle |
| `dry_run` | `none` | `source` keeps the database read-only; `store` also writes nothing |
| `backfill_sizes` | `false` | fill missing `bytes` into `_index/` instead of archiving |
| `backfill_apply` | `false` | with `backfill_sizes`, actually write (else report-only) |

`--rebuild-index` deliberately has **no** CI input: it re-decides every week's state and is a local
operation you should be watching.

### Scheduling

Weekly is the natural cadence — the archiver works in whole ISO weeks. Two ways to fire it:

- **GitHub cron** in the caller: `cron: "30 19 * * 0"` (Sundays 19:30 UTC).
- **The [Cloudflare scheduler](../scheduler/README.md)**, which has an `archive` cadence at the same
  Sunday 19:30 UTC. Unlike the other cadences it is **opt-in**: a client runs it only if its roster
  entry names `"archive"` in `cadences`.

Either way the hour is the point. 19:30 UTC on a Sunday sits ~3.5 h after the Sunday anchor-hour
backup that gets promoted to `weekly/`, and after that day's durable verify — so a fresh, hash-checked,
WORM-locked weekly dump exists *before* any rows are pruned. Every delete is therefore preceded by a
durable snapshot of the same data.

### On the dashboard

Archived tables get their own columns beside the backup heatmap, one per table, plus `Rows archived` /
`Rows pruned` / `Archive stored` / `Archive issues` stat cards. See
[Backup-history dashboard → Archive columns](dashboard.md#archive-columns).
