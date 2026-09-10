# Backup-history dashboard

A static, self-contained page visualises **every 8-hourly run over the 1-year window** as a heatmap.
Every cell — backup slot or archive week — says two things in the same two places:

- the **body** (the square) answers *do we have data for this period?* — green = healthy & retained,
  brighter green = restore-verified, grey = aged out of retention, blue = rows archived, brighter
  blue = archived **and** pruned from the database, blank = none;
- the **mark** (a small bar along the bottom) answers *did the runs in this period go clean?* —
  nothing = clean, **red = failed**, **amber = a restore/hash drill failed or a prune was refused**,
  two dashes = the runs disagreed, a muted bar on a blank body = a run went clean but the body has
  nothing of its own to say.

So a failed backup is a red bar in an empty square (it produced no data), while a backup whose drill
failed is a green square with an amber bar (the dump is fine; the drill is not). Counts, sizes, times
and run links are in the tooltip. A **theme control** in the header offers Auto / Light / Dark, and
remembers the choice; Auto follows the operating system.

It reads an **append-only run-log in
R2** (no server, no DB) that the backup + drill + durable-verify scripts write via `runlog.ts`:

```
_log/<basename>/runs-YYYY-MM.jsonl           # {ts, ok, tiers, bytes, key, sha256, runId, runUrl, error}
_log/<basename>/verifications-YYYY-MM.jsonl   # {ts, verifiedTs, ok, ratio, tier, key, kind, counts, reason, runId, runUrl}
```

`kind` is `restore` or `hash`; `counts` (restored per-table) and `reason` are **private** (never
published). Monthly files roll over by name; an R2 lifecycle rule trims old months. `build-dashboard.ts`
reads the logs, **scrubs** them to a public payload (drops `sha256`, `key`, `counts`, `reason`, and raw
error text), `esbuild`-bundles the SVG renderer into a single `index.html`, and uploads it to the
**separate public** dashboard bucket at `<path-prefix>/<name>/index.html` (`dashboard.path-prefix`,
default `""` → `<name>/index.html`). Setting `path-prefix` lets several projects share one dashboard
bucket + custom domain, e.g. `https://ops.example.com/backups/<name>/index.html`.

> **Privacy.** The published page includes the project label + sizes + tiers + timestamps + verification
> ratio + run links; it **drops raw error text** (set `dashboard.hide-run-links: true` to also drop run
> links). The rich raw logs never leave the private bucket. To make the page itself private, front the
> public bucket with a custom domain + Cloudflare Access — no code change.

## Archive columns

When the profile has an [`archive:`](archiving.md) block, a
narrow **sibling block appears to the right of the heatmap** — one column per archived table, labelled
`T1`, `T2`, … (the key from `Tn` to the table name is in the legend, the header sentence and every
tooltip). It shares the heatmap's row pitch, and uses the same body/mark grammar as the backup
grid — but with a twist worth knowing, because **the two channels are about two different weeks**:

| | subject | source |
|---|---|---|
| **body** | the rows *dated* that week — archived? pruned? | `_index/` under the archive store prefix |
| **mark** | the archiver runs that *executed during* that week | `_log/<basename>/archives-*.jsonl` |

The archive that ran on 6 September archived data from *May*, so a clean mark beneath a "pruned" body
does **not** mean "that run pruned this week's rows". Three things keep them apart: the tooltip splits
into two halves across a rule, the legend has two headed groups (DATA / RUNS), and a filled square
never looks like a thin bar. So: **blue body** = those rows are in the archive, **brighter blue** =
they have also been deleted from the database (a prune is gated on a fingerprint re-check, so a pruned
week is by construction a verified one), **blank body** = no rows for that week, or none archived yet;
and **muted bar** = a run happened that week and went clean, **amber bar** = prune refusals or
anomalies, a human must look, **red bar** = the run failed, **no bar at all** = no archiver run that
week. A week holding several runs shows two dashes when they disagreed, and clicks to a chooser,
exactly as backup slots do.
A third row of stat cards appears alongside — `Rows archived`, `Rows pruned`, `Archive stored`,
`Archive issues` — and `Stored` / `Est. cost` fold in the archive objects, since they share the bucket
and the bill. Archive runs do **not** count toward `Total runs` / `Failed`: those cards are about
backups. It reads `_log/<basename>/archives-YYYY-MM.jsonl` (one record per **table** per run, written
by `archive-table.ts` since day one) and scrubs it the same way — no `error`, no `runId`, schema
stripped from the table name; row counts and object sizes are published, like dump sizes already are.
The bodies come from a second read: `<store-prefix>/<table>/_index/*.jsonl`, scrubbed to
`{table, week, state, rows}` — fingerprints, digests, part numbers and part roles never leave the
private bucket. That read **fails soft**: the same bucket-scoped R2 token already reads `_log/`, but if
`_index/` cannot be listed the page renders with runs only, and says so in the build log.
A profile with no `archive:` block renders exactly the page it did before.

## Linking Slack to the published page

Set **`dashboard.url`** in the profile to hyperlink the "`<basename> DB backup`" title — in the daily
Slack header **and in every failure alert** — to the published page. The public hostname isn't derivable from the bucket name — fetch it once, as
described in [setting-up-gitfather.md §3d](setting-up-gitfather.md#3d-public-dashboard--profile--secrets):

```bash
npx wrangler r2 bucket dev-url get <DASHBOARD_R2_BUCKET>   # managed r2.dev URL
npx wrangler r2 bucket domain list <DASHBOARD_R2_BUCKET>   # custom domain
```

## Build locally

```bash
npm ci
npx tsx scripts/build-dashboard.ts --sample --out /tmp/dash/index.html   # sample data
# drop --sample + export the R2 env (+ PROFILE=…/your.yaml for the label/timezone) to render real logs
```
