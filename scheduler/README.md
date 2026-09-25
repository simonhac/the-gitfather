# gitfather-scheduler

## Who watches the watchdog

`SCHEDULER_HEARTBEAT_URL` (optional Worker secret) — a BetterStack heartbeat pinged at the end of
each **cron** tick, and only when the tick actually DELIVERED: every rostered client must yield a
watchdog verdict other than `error`/`no-config`.

The staleness watchdog is the only thing that notices a missed backup, and it runs inside this
Worker. The per-client `HEARTBEAT_URL` does cover a dead scheduler, but only after a full 8-hour
slot elapses. This closes that to ~30 minutes.

Three conditions are deliberate, and loosening any of them breaks the signal:

- **Not "the Worker woke up".** `scheduled()` runs happily with an invalid `ROSTER`, revoked App
  auth, or a watchdog throwing on every client.
- **`stale-broken` and friends STILL ping.** Those mean the watchdog looked, formed a verdict and
  paged — it is working. Withholding the ping would duplicate the Slack alert and drop the
  scheduler's liveness signal at exactly the moment a backup needs attention. See `src/health.ts`.
- **Cron path only, never `/trigger`.** Debugging a dead scheduler is precisely when someone hits
  `/trigger` repeatedly, which would mask the thing they are investigating.

Unset means off, so `wrangler dev` can never keep production's monitor green.

`GET /health/jobs` answers a different question: did every job **prove** its claim recently? The
verify and archive jobs write `_health/<name>/<job>.json` to their own bucket behind the same gates
their push heartbeats used. This reads every one that is owed, from the roster's cadences crossed
with each published `_config/` (`archives` says whether that database archives anything). It
returns 503 on any missing, stale or unreadable proof, and on zero owed proofs. One uptime monitor
here replaces a heartbeat per job per project. See
[`docs/slack-and-alerting.md`](../docs/slack-and-alerting.md#job-proofs-one-monitor-for-every-job).
Cost: about 1 + 2 subrequests per database per poll (config list, config get, one get per proof),
which stays well inside the 50-per-invocation limit.

`GET /health` is stateful: it reads `_scheduler/cron.json` — a **cron-only** record, deliberately not
`state.json`, which `/trigger` also overwrites — and returns **503** when the last cron tick is older
than 25 minutes (two missed ticks; Cron Triggers are best-effort), when it **did not deliver**, when
the roster is empty or unparseable, or when the timestamp is in the future. It previously returned a
constant `"ok"`, which was false comfort — a Worker's fetch handler answers even with its Cron
Trigger deleted or its App key revoked. It is also an independent path: the heartbeat is
Cloudflare→BetterStack, `/health` is BetterStack→Cloudflare, so a monitor here still fires if the
Worker loses outbound fetch.


A single Cloudflare Worker that **replaces GitHub Actions cron and runs the staleness watchdog**. One
Cron Trigger (`*/10 * * * *`) wakes the Worker every 10 minutes; it works out which cadences are due,
fires each client's caller workflow via GitHub's REST [`workflow_dispatch`][dispatch] API for the
dispatched cadences, and runs the watchdog **natively** against each client's private R2 bucket.

```
*/10 tick ──▶ dueCadences(scheduledTime) ──▶ POST …/workflows/<file>/dispatches   (backup / verify / archive, per client)
                                          ├─▶ watchdog: list <prefix>/2hourly/ in the client's bucket, self-heal / page
                                          └─▶ write _scheduler/state.json + log to the shared bucket
```

## Why this exists

GitHub Actions cron is best-effort: it drops/delays ticks and auto-disables scheduled workflows after
60 days of repo inactivity. Cloudflare Cron Triggers are cheaper to run and more punctual on average —
but they are **also** best-effort, so the real guarantee is the watchdog (self-heals a missed backup,
pages when it can't) plus the external `HEARTBEAT_URL` dead-man's-switch (pages if the Worker itself dies).

The watchdog used to be a GitHub Actions job dispatched every 10 minutes. That was ~80% of each client's
Actions minutes, and — worse — it ran *inside* the thing it was watching: when a private org's Actions
billing lapsed, backups stopped **and so did the watchdog**. It now runs here, outside GitHub, for free.

## Cadences

| Cadence         | When (UTC)        | Dispatches                | Input               |
| --------------- | ----------------- | ------------------------- | ------------------- |
| `staleness`     | every 10 min      | *(runs natively — see [The watchdog](#the-watchdog))* | — |
| `backup`        | every 8h (`00/08/16` UTC) | `pg-backup.yml`       | `reason: schedule`  |
| `durableVerify` | daily `18:30`     | `pg-durable-verify.yml`   | —                   |
| `archive`       | Sundays `19:30` (opt-in)  | `pg-archive.yml`      | —                   |
| `restoreDrill`  | manual only       | `pg-restore-drill.yml`    | —                   |

`archive` is the one **opt-in** cadence: a client runs it only if its roster entry names `"archive"` in
`cadences`. `19:30` on a Sunday is ~3.5 h after the Sunday anchor-hour backup that gets promoted to
`weekly/`, and after that day's `durableVerify` — so a fresh, hash-checked, WORM-locked weekly dump
exists before the archiver prunes a single row.

`durableVerify` must run **after** every client's `anchor-hour-utc` (so the day's `daily/` object exists
to verify). `18:30` suits anchor hours earlier in the day — adjust `dueCadences()` in `src/index.ts` if
yours is later. `restoreDrill` is superseded by `durableVerify`; fire it on demand via `/trigger`.

`backup` is dispatched with `reason: schedule` so it renders as a clean scheduled run (no 🖐️ marker) —
see `runOrigin()` in `../scripts/lib/schedule.ts`. The other callers take no inputs (extra keys → 422).

## Configuration

Two kinds of configuration, deliberately kept apart:

- **`wrangler.jsonc`** (gitignored — copy from `wrangler.example.jsonc`) holds the NON-secret deployment
  shape: the R2 bucket bindings and the client **roster** (a `vars.ROSTER` array). It is a commented
  JSONC file you can read back and diff, not a secret you paste blind. The real one lives in a private
  repo (`npm run config:pull` fetches it; defaults to `simonhac/infra`, override with
  `GITFATHER_CONFIG_REPO` / `_PATH` / `_REF`). Edit it there first, then deploy. Before deploying from a
  pulled copy, diff it against the live Worker, which is the only guaranteed-current copy:
  `npx wrangler deployments list`, then `npx wrangler versions view <id> --json`.
- **Secrets** (`wrangler secret put …`, never committed):
  - `GH_APP_ID` — the GitHub App's id (the JWT `iss`). See [GitHub App setup](#github-app-setup).
  - `GH_APP_PRIVATE_KEY` — the App private key as a **PKCS#8** PEM (`-----BEGIN PRIVATE KEY-----`). GitHub
    issues PKCS#1; convert it **once** with `openssl pkcs8 -topk8 -nocrypt` (see below). The Worker signs a
    short-lived JWT with it and mints per-repo, 1h `actions:write` installation tokens — there is **no
    long-lived token to expire** (no silent-stop failure mode) and the blast radius is `actions:write` on the
    installed repos only.
  - `TRIGGER_SECRET` — a random string gating `/trigger` and `/state`.
  - `SLACK_BOT_TOKEN` — the watchdog's bot token (`chat:write`); the same bot the backup job uses is fine.
    A client whose channel lives in a different workspace gets its own `SLACK_BOT_TOKEN_<ID>` (id upper-cased,
    non-alphanumerics → `_`).
  - `ALERT_WEBHOOK_URL_<ID>` *(optional, per client)* — a Slack-compatible `{"text":…}` failure webhook.

Every **watchdog setting** (cadence, grace, backstop, repage throttle, self-heal, dry-run, Slack channel,
mention, dashboard link) lives in the client's own **profile**, in its own repo — and the Worker never reads
GitHub. Instead the backup job publishes the validated `staleness:` block to
`_config/<name>/watchdog.json` in the client's bucket on every run (`scripts/lib/watchdogConfig.ts`), and
the Worker reads it there. Config flows GitHub → Cloudflare, never the reverse; an edit lands with the next
backup run.

### `ROSTER` (in `wrangler.jsonc` → `vars`)

Bootstrap identifiers only. A client is its `id` + `owner` + `repo` + the App's `installationId` on that
owner + the **binding name** of its private dump bucket:

```jsonc
"r2_buckets": [
  { "binding": "STATE",    "bucket_name": "your-shared-dashboard-bucket" },
  { "binding": "ALPHA_R2", "bucket_name": "alpha-pg-backups" },
  { "binding": "BETA_R2",  "bucket_name": "beta-pg-backups" }
],
"vars": {
  "ROSTER": [
    { "id": "alpha", "owner": "your-org",  "repo": "alpha-app", "installationId": 11111111, "bucket": "ALPHA_R2" },
    { "id": "beta",  "owner": "other-org", "repo": "beta-app",  "installationId": 22222222, "bucket": "BETA_R2",
      "cadences": ["backup", "staleness", "durableVerify", "archive"] }
  ]
}
```

- `id` — opaque label; the **only** client identifier that ever reaches the logs (the shared bucket is public).
- `bucket` — an `r2_buckets` binding in the same file. All buckets must be in **this** Cloudflare account
  (native bindings are free and in-network; the Worker holds no S3 keys). A bucket may host several backups
  (`name`s): the watchdog checks every `_config/*/watchdog.json` it finds.
- `installationId` — the App's installation id on this owner's account (see setup step 4). Not secret.
- `cadences` (optional) — restrict which cadences a client runs. Omit it and the client runs every
  cadence **except** the opt-in ones (`archive`); name a cadence explicitly to opt in. `beta` above
  opts out of `restoreDrill`, and a client that wants the archiver must list `"archive"` itself.
- `workflows` (optional) — per-client caller-filename overrides, only if a client named a caller file
  differently, e.g. `"workflows": { "backup": "pg-backup-eu.yml" }`. The watchdog's heal target is the
  profile's `staleness.heal-workflow`, not this.

The caller-workflow filenames are identical across consuming repos by convention, so they're **defaults**
in the Worker (`DEFAULT_WORKFLOWS` in `src/github.ts`).

## The watchdog

`src/watchdog.ts` — a port of the old `check-staleness.ts`, sharing its decision code with the Actions-side
scripts (`scripts/lib/schedule.ts`, `alertDecision.ts`, `dailyRow.ts`, `runlogParse.ts`, `slackApi.ts`) so
the two runtimes cannot drift on what "overdue", "broken" or a ⬜ mean. Per client bucket, per published
config, every tick:

1. Lists `<backup-prefix>/2hourly/`, takes the newest object. Nothing there → page. Smaller than
   `dump.min-bytes` → **broken**, page, never heal.
2. Slot-based freshness (`slotState`): the current slot is **overdue** once `grace-minutes` past its boundary
   with nothing landed; `max-age-hours` is only a backstop.
3. Re-renders today's Slack row in place so elapsed-but-empty slots show as ⬜ (no-op if no message yet).
4. **Fresh** → if an alert episode is open, posts 🟢 RECOVERED and closes it.
5. **Stale** → self-heal, in order: `self-heal: false` → page · a backup already queued/running → wait · the
   two newest completed runs both failed → **broken**, page with the run-log's classified cause, don't retry ·
   `dry-run` → say what it would do · else dispatch **one** catch-up (`reason=self-heal` → 🩹).
6. Pages are throttled per `repage-minutes` (entry and any change of cause always page); the episode
   state is `_status/<name>/alert-state.json` in the client's bucket, the same object the old job used.

Outcomes are recorded per tick in `_scheduler/state.json` (`watchdog: [{ id, name, outcome }]`), as codes
only: `fresh` · `recovered` · `stale-healed` · `stale-inflight` · `stale-broken` · `stale-dry-run` ·
`stale-no-heal` · `stale-unhealed` · `broken-size` · `no-objects` · `bad-stamp` · `no-config` · `error`.
`no-config` means the bucket has no `_config/*/watchdog.json` yet — run the client's backup once.

## GitHub App setup

The Worker authenticates as a **GitHub App** rather than a personal access token: least privilege
(`actions:write` on only the installed repos), short-lived auto-minted tokens (nothing to rotate, no
silent-expiry outage), and one App can serve repos under **different owners** (a single fine-grained PAT
cannot — it's scoped to one owner). One-time GitHub-side setup:

1. **Create the App** — Settings → Developer settings → GitHub Apps → New. Repository permission
   **Actions → Read and write** (everything else "No access"); **uncheck Webhook → Active**; "Where can
   this be installed" → **Any account** (so it can be installed on other owners/orgs). Note the **App ID**.
2. **Generate a private key** — on the App's page, "Generate a private key" (downloads a PKCS#1 PEM). Convert
   it once to the PKCS#8 form WebCrypto needs, then **delete both local copies** after step 3:
   ```sh
   openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem   # output starts BEGIN PRIVATE KEY
   ```
   Never commit either file (the repo is public).
3. **Install** the App on each owner, selecting **only** that owner's one client repo. Installing on a single
   repo (not "all repositories") is the real scope wall — even an un-down-scoped token can't reach others. For
   orgs, an org owner may need to approve.
4. **Record the installation ids** — from the install URL (`…/installations/<id>`) or with the App JWT:
   ```sh
   curl -s -H "Authorization: Bearer $APP_JWT" -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/<owner>/<repo>/installation | jq .id
   ```
   Put each into its `ROSTER` entry as `installationId`.

The App needs **only** `Actions: Read and write`. Do not grant `Contents` — the Worker never reads a repo;
the watchdog's settings reach it via the bucket (see [Configuration](#configuration)).

**Rotating the key** — the App private key is the one long-lived secret, so rotation is the main ongoing
task. An App holds up to 25 keys at once, so it's zero-downtime: generate a new private key on the App →
`openssl pkcs8 -topk8 -nocrypt` it → `wrangler secret put GH_APP_PRIVATE_KEY < app.pkcs8.pem` →
`npm run deploy` → validate via `/trigger` → **then** delete the old key in the App settings. Never delete
the old key before the new one is deployed and validated.

**If a dispatch fails** (a non-204 in the `/trigger` response or `wrangler tail`): `401` = bad/expired JWT
(usually local clock skew, or the key isn't the PKCS#8 form); `404` = wrong `installationId` or the App
isn't installed on that repo; `403` = the installation lacks `actions:write`; `422` = bad workflow input.
A token-mint failure (vs. a dispatch rejection) is logged as a dispatch `status -1`.

## Deploy

```sh
cd scheduler
npm install
npm run config:pull                           # existing deployment; or, first time:
# cp wrangler.example.jsonc wrangler.jsonc    #   then set the real bucket names + ROSTER
wrangler login                                 # or export CLOUDFLARE_API_TOKEN
wrangler secret put GH_APP_ID                   # the App ID (setup step 1)
wrangler secret put GH_APP_PRIVATE_KEY < app.pkcs8.pem  # multi-line: pipe the file in (the prompt only reads one line)
wrangler secret put TRIGGER_SECRET             # paste a random string
wrangler secret put SLACK_BOT_TOKEN            # the watchdog's bot token (optional; Slack off without it)
npm run deploy
```

## Cut over

### From GitHub cron (first-time install)

Remove the GitHub cron **before** the Worker starts dispatching, so the two schedulers never overlap and
every run in your Actions history / Slack / dashboard is unambiguously Worker-originated — much simpler to
debug. The tradeoff: a short window with no scheduler between removing cron and the Worker's first tick.
With only a few small backups that's fine — bridge it with a manual dispatch.

1. **(optional) mute the dead-man's-switch** for the maintenance window so the gap doesn't page.
2. In each client repo, delete the `schedule:` block from every caller — keep `workflow_dispatch:` and
   everything else verbatim:
   ```yaml
   on:
     schedule:                    # ← delete these two lines
       - cron: "0 0,8,16 * * *"   # ←
     workflow_dispatch:        # keep
       inputs: { ... }         # keep (the backup caller's `reason` input is required by self-heal)
   ```
   Apply to `pg-backup.yml`, `pg-durable-verify.yml` (and `pg-archive.yml` / `pg-restore-drill.yml` if
   present). **Do not** touch `name:` (the dashboard's `workflow_run` matches it) or `pg-dashboard.yml`
   (stays `workflow_run`). GitHub now schedules nothing.
3. **(optional) confirm dispatch still works** with cron gone, and avoid waiting up to 8h for the first
   backup: `gh workflow run pg-backup.yml -R your-org/alpha-app -f reason=schedule`. This run also
   publishes the watchdog config, so the watchdog is live from the Worker's first tick.
4. **Deploy the Worker** (above). Its `*/10` cron is now the sole scheduler and the sole watchdog.
5. **Validate** — every run from here is Worker-originated:
   ```sh
   # Local sanity check: fire the scheduled handler and watch which cadences fan out
   npm run dev    # then open http://localhost:8787/__scheduled?cron=*/10+*+*+*+*

   # Live: tail logs in one terminal …
   npm run tail
   # … and run the watchdog for one client in another (expect `"outcome": "fresh"`)
   curl -H "X-Trigger-Secret: $TRIGGER_SECRET" \
     "https://gitfather-scheduler.<subdomain>.workers.dev/trigger?cadence=staleness&client=alpha"
   # Read back the latest scheduler state
   curl -H "X-Trigger-Secret: $TRIGGER_SECRET" \
     "https://gitfather-scheduler.<subdomain>.workers.dev/state"
   ```
   Confirm a `workflow_dispatch` run in each client's Actions tab on a `cadence=backup` dispatch, a new
   `…/2hourly/` object, a clean Slack tick, and a `HEARTBEAT_URL` ping. Then **unmute the dead-man's-switch**.

**Rollback:** re-add a `schedule:` block to a caller and cron resumes within a tick.

### From the Actions-hosted watchdog (upgrading an existing deployment)

Before this version the Worker dispatched a `pg-staleness-check.yml` caller every tick. Upgrading:

1. Pull; each client's next backup run publishes `_config/<name>/watchdog.json` (harmless to the old
   Worker). To publish now: `gh workflow run pg-backup.yml -R <owner>/<repo> -f reason=schedule`.
2. In `wrangler.jsonc`: add an `r2_buckets` binding per client bucket, move the roster from the `CLIENTS`
   secret into `vars.ROSTER` (adding each entry's `bucket`), then `wrangler secret put SLACK_BOT_TOKEN`
   and `npm run deploy`. The Worker stops dispatching the Actions watchdog at once; the old callers carry
   no cron, so they simply go idle — **no gap**.
3. `curl …/trigger?cadence=staleness` → expect `fresh` per client; `npm run tail` across a couple of ticks.
4. Clean up: delete `.github/workflows/pg-staleness-check.yml` from each client repo, and
   `wrangler secret delete CLIENTS`.

## Endpoints

| Path                                  | Auth                  | Purpose                                   |
| ------------------------------------- | --------------------- | ----------------------------------------- |
| `GET /health`                         | open                  | liveness                                  |
| `GET /health/jobs`                    | open                  | every client's job proofs; 503 if any owed one is missing or stale (`src/jobs.ts`) |
| `GET /trigger?cadence=<c>&client=<id>`| `X-Trigger-Secret`    | manually fire one cadence (`client` opt.); `staleness` runs the watchdog and returns its outcomes |
| `GET /state`                          | `X-Trigger-Secret`    | return `_scheduler/state.json`            |

## Free-tier math

Workers Free: 100k req/day · 5 cron triggers/account · 10 ms CPU/invocation · 50 subrequests/invocation.
This Worker uses **1** cron trigger and **144** invocations/day (~0.15%). Every R2 binding call and every
`fetch` is a subrequest. Per client per tick the watchdog makes ~7 on the fresh path (config list + get,
2hourly list, Slack-row get + update + put, alert-state get) and ~13 when stale (plus a token mint, a run
listing, one or two run-log reads, the dispatch, a page); the 8-hourly backup dispatch adds ~2 cold / ~1
warm. Budget for **about 5 clients** per Worker on the free plan; beyond that, split the roster across
Workers or move to Workers Paid (10,000 subrequests). CPU is a few ms (one RS256 sign per cold mint plus
some Intl formatting); R2 binding reads/writes are in-network and free. **Zero new charges** — and the
Actions minutes the old watchdog burned (~4,300/month per client) are gone.

[dispatch]: https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
