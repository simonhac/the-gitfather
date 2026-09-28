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

`GET /health` is stateful. It reads `_scheduler/cron.json`, a **cron-only** record (deliberately not
`state.json`, which `/trigger` also overwrites), and returns **503** when:
- the last cron tick is older than 25 minutes (two missed ticks; Cron Triggers are best-effort);
- the last tick **did not deliver**;
- the roster is empty or unparseable;
- the timestamp is in the future.

It also 503s when **Slack is failing**, judged from the Slack tick's own record,
`_scheduler/slack.json`. That covers no Slack tick ever recorded (the second cron trigger is
missing), a tick older than 25 minutes, or the hourly `auth.test` failing (`invalid_auth`,
`token_revoked`, …). The Worker is the only thing that posts to Slack, so a dead token silences
every alert, and it must show up here rather than when an alert fails to arrive. The body's `slack`
field reads `ok`, `failing` or `off` (no token set, which is not a failure). A channel the app was
never invited to is *not* visible here, because `auth.test` proves only the token; that shows as
`not_in_channel` in the Worker log.

`/health` previously returned a constant `"ok"`, which was false comfort: a Worker's fetch handler
answers even with its Cron Trigger deleted or its App key revoked. It is also an independent path.
The heartbeat is Cloudflare→BetterStack and `/health` is BetterStack→Cloudflare, so a monitor here
still fires if the Worker loses outbound fetch.


A single Cloudflare Worker that **replaces GitHub Actions cron, runs the staleness watchdog, and is
the only thing that posts to Slack**. Two Cron Triggers wake it:
- **The main tick** (`*/10 * * * *`) works out which cadences are due. It fires each client's caller
  workflow via GitHub's REST [`workflow_dispatch`][dispatch] API for the dispatched cadences, and runs
  the watchdog **natively** against each client's private R2 bucket.
- **The Slack tick** (`5,15,25,35,45,55 * * * *`), five minutes later, keeps each client's daily
  Slack row current and announces any job outcome whose notify never arrived.

Finished jobs call `POST /notify` to be announced within seconds.

```
*/10 tick  ──▶ dueCadences(scheduledTime) ──▶ POST …/workflows/<file>/dispatches   (backup / verify / archive, per client)
                                           ├─▶ watchdog: list <prefix>/intraday/ in the client's bucket, self-heal / page
                                           └─▶ write _scheduler/state.json + log to the shared bucket
:05 tick   ──▶ per client: refresh the daily row (⬜) · list unannounced _status/_outcome/ records ──▶ announce ≤2
                                           └─▶ hourly auth.test · write _scheduler/slack.json
job's last step ──▶ POST /notify (GitHub OIDC) ──▶ read that run's outcome record ──▶ post to the roster channel
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
| `backup`        | per client: `backups-per-day` from `anchor-hour-utc` (default `00/08/16`) | `pg-backup.yml` | `reason: schedule` |
| `durableVerify` | daily `18:30`     | `pg-durable-verify.yml`   | —                   |
| `archive`       | Mondays `00:30` (opt-in)  | `pg-archive.yml`      | —                   |
| `restoreDrill`  | manual only       | `pg-restore-drill.yml`    | —                   |

`backup` is scheduled **per client**. Every hour on the hour is a candidate; the Worker reads the
client's published `_config/*/watchdog.json` (the same listing the watchdog uses that tick) and dispatches
when any of them — one per database — is due under its profile's `backups-per-day` and `anchor-hour-utc`.
A client with no published config yet (or whose listing fails) runs on the default 00/08/16 UTC grid, so
its first backup can publish one. A profile edit takes effect after the next backup publishes it.

`archive` is the one **opt-in** cadence: a client runs it only if its roster entry names `"archive"` in
`cadences`. `00:30` on a Monday is just after the UTC week boundary at which archive weeks become
eligible (a run before it waits a whole extra week), and after Sunday's anchor-hour backup that gets
promoted to `weekly/` and that day's `durableVerify` — so a fresh, hash-checked, WORM-locked weekly dump
exists before the archiver prunes a single row.

`durableVerify` must run **after** every client's `anchor-hour-utc` (so the day's `daily/` object exists
to verify). `18:30` suits anchor hours earlier in the day — adjust `dueCadences()` in `src/cadences.ts` if
yours is later. `restoreDrill` is superseded by `durableVerify`; fire it on demand via `/trigger`.

`backup` is dispatched with `reason: schedule` so it renders as a clean scheduled run (no 🖐️ marker) —
see `runOrigin()` in `../scripts/lib/schedule.ts`. The other callers take no inputs (extra keys → 422).

## Configuration

Two kinds of configuration, deliberately kept apart:

- **`wrangler.jsonc`** (gitignored — copy from `wrangler.example.jsonc`) holds the NON-secret deployment
  shape: the two cron triggers, the R2 bucket bindings, the client **roster** (a `vars.ROSTER` array),
  and two more `vars`:
  - `NOTIFY_AUDIENCE`: set it to `"the-gitfather"`, the OIDC audience the reusable workflows request.
    Unset, `/notify` answers 503 and only the Slack tick announces runs, ≤10 min late.
  - `ENGINE_REPO` (optional): the `owner/repo` whose reusable workflows may notify. The default is
    `simonhac/the-gitfather`; set it only for a fork.

  It is a commented JSONC file you can read back and diff, not a secret you paste blind. The real one
  lives in a private repo (`npm run config:pull` fetches it; defaults to `simonhac/infra`, override
  with `GITFATHER_CONFIG_REPO` / `_PATH` / `_REF`). Edit it there first, then deploy. Before deploying
  from a pulled copy, diff it against the live Worker, which is the only guaranteed-current copy:
  `npx wrangler deployments list`, then `npx wrangler versions view <id> --json`.
- **Secrets** (`wrangler secret put …`, never committed):
  - `GH_APP_ID` — the GitHub App's id (the JWT `iss`). See [GitHub App setup](#github-app-setup).
  - `GH_APP_PRIVATE_KEY` — the App private key as a **PKCS#8** PEM (`-----BEGIN PRIVATE KEY-----`). GitHub
    issues PKCS#1; convert it **once** with `openssl pkcs8 -topk8 -nocrypt` (see below). The Worker signs a
    short-lived JWT with it and mints per-repo, 1h `actions:write` installation tokens — there is **no
    long-lived token to expire** (no silent-stop failure mode) and the blast radius is `actions:write` on the
    installed repos only.
  - `TRIGGER_SECRET` — a random string gating `/trigger`, `/state` and `/slack`.
  - `SLACK_BOT_TOKEN` — the **the-gitfather** Slack app's bot token (`chat:write` +
    `chat:write.customize`). It is the **only** Slack token anywhere: client repos hold none. Every
    post goes through it, to the channel and under the name in each client's roster `slack` block.
    Unset means Slack is off. The per-client `SLACK_BOT_TOKEN_<ID>` override is gone, so delete any
    left over.
  - `ALERT_WEBHOOK_URL_<ID>` *(optional, per client; id upper-cased, non-alphanumerics → `_`)* — a
    Slack-compatible `{"text":…}` webhook that gets every page for that client. It fires even when
    the client has no Slack.
  - `SCHEDULER_HEARTBEAT_URL` *(optional)* — see [Who watches the watchdog](#who-watches-the-watchdog).

Every **watchdog setting** (cadence, grace, backstop, repage throttle, self-heal, dry-run, mention,
dashboard link) lives in the client's own **profile**, in its own repo, and the Worker never reads the
client's repo. Instead the backup job publishes the validated `staleness:` block to
`_config/<name>/watchdog.json` in the client's bucket on every run (`scripts/lib/watchdogConfig.ts`),
and the Worker reads it there. Config flows GitHub → Cloudflare, never the reverse, and an edit lands
with the next backup run. The **Slack channel and identity** are the exception, deliberately. They live
in the roster, next to the token, because the channel decides where an operator-held credential posts.
Anyone holding the client's CI key can write its bucket, so the channel must not come from there.

### `ROSTER` (in `wrangler.jsonc` → `vars`)

Bootstrap identifiers only. A client is:
- its `id`, `owner` and `repo`;
- the App's `installationId` on that owner;
- the **binding name** of its private dump bucket;
- optionally, where and as whom to post about it in Slack.

```jsonc
"r2_buckets": [
  { "binding": "STATE",    "bucket_name": "your-shared-dashboard-bucket" },
  { "binding": "ALPHA_R2", "bucket_name": "alpha-pg-backups" },
  { "binding": "BETA_R2",  "bucket_name": "beta-pg-backups" }
],
"vars": {
  "ROSTER": [
    { "id": "alpha", "owner": "your-org",  "repo": "alpha-app", "repositoryId": 123456789,
      "installationId": 11111111, "bucket": "ALPHA_R2",
      "slack": { "channel": "C0123456789", "username": "alpha backup", "iconEmoji": ":floppy_disk:" } },
    { "id": "beta",  "owner": "other-org", "repo": "beta-app",  "installationId": 22222222, "bucket": "BETA_R2",
      "cadences": ["backup", "staleness", "durableVerify", "archive"],
      "slack": { "channel": "C0123456789" } }
  ],
  "NOTIFY_AUDIENCE": "the-gitfather"
}
```

- `id` — opaque label; the **only** client identifier that ever reaches the logs (the shared bucket is public).
- `owner` / `repo` — the consuming repo. `/notify` identifies a client by the OIDC token's
  `repository`, case-insensitively, so one repo may appear in the roster only once.
- `repositoryId` (optional, recommended) — GitHub's numeric id for `owner/repo`
  (`gh api repos/<owner>/<repo> --jq .id`). When set, `/notify` also requires the token's
  `repository_id` to match, so a repo deleted and re-created under the same name can't inherit the
  client.
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
- `slack` (optional) — where and as whom the Worker posts about this client. **No block means Slack
  is off for the client**, though its failure webhook still fires. Unknown keys are rejected.
  - `channel` — the channel id (`C…`, `G…` or `D…`). Invite the the-gitfather app to it.
  - `username` — the display name on every post. It defaults to `<id> backup` and needs
    `chat:write.customize`.
  - `iconEmoji` (e.g. `":floppy_disk:"`) **or** `iconUrl` (an `https://` image). Not both; omit both
    for the app's own icon.

  `chat.update` can't change a message's sender, so a new name or icon shows on the next *new*
  message. Today's daily row keeps the identity it was posted with. Moving `channel` starts a fresh
  daily row in the new channel.

The caller-workflow filenames are identical across consuming repos by convention, so they're **defaults**
in the Worker (`DEFAULT_WORKFLOWS` in `src/github.ts`).

## The watchdog

`src/watchdog.ts` — a port of the old `check-staleness.ts`. It shares its decision code with the
Actions-side scripts (`scripts/lib/schedule.ts`, `alertDecision.ts`, `dailyRow.ts`, `runlogParse.ts`,
`slackText.ts`), so the two runtimes cannot drift on what "overdue", "broken" or a ⬜ mean. Per
client bucket, per published config, every main tick:

1. Lists `<backup-prefix>/intraday/` (and, for one release, the legacy `2hourly/`), takes the newest object. Nothing there → page. Smaller than
   `dump.min-bytes` → **broken**, page, never heal.
2. Slot-based freshness (`slotState`, slots phased from `anchor-hour-utc`): the current slot is **overdue** once `grace-minutes` past its boundary
   with nothing landed; `max-age-hours` is only a backstop.
3. **Fresh** → if an alert episode is open, posts 🟢 RECOVERED and closes it.
4. **Stale** → self-heal, in order: `self-heal: false` → page · a backup already queued/running → wait · the
   two newest completed runs both failed → **broken**, page with the run-log's classified cause, don't retry ·
   `dry-run` → say what it would do · else dispatch **one** catch-up (`reason=self-heal` → 🩹).
5. Pages are throttled per `repage-minutes` (entry and any change of cause always page); the episode
   state is `_status/<name>/alert-state.json` in the client's bucket, the same object the old job used.

Its posts go through the client's roster channel and identity, and pages also go to its
`ALERT_WEBHOOK_URL_<ID>`. Everything a page quotes came from the bucket, including the run-log's error
text, so the page is escaped and the run-log excerpt sits in a code span. The daily row's ⬜
placeholders are the Slack tick's job now ([Slack](#slack)), not the watchdog's.

Outcomes are recorded per tick in `_scheduler/state.json` (`watchdog: [{ id, name, outcome }]`), as codes
only: `fresh` · `recovered` · `stale-healed` · `stale-inflight` · `stale-broken` · `stale-dry-run` ·
`stale-no-heal` · `stale-unhealed` · `broken-size` · `no-objects` · `bad-stamp` · `no-config` · `error`.
`no-config` means the bucket has no `_config/*/watchdog.json` yet — run the client's backup once.

## Slack

The Worker is the only thing that posts to Slack, with one token (`SLACK_BOT_TOKEN`). Jobs never post.
Each one writes an **outcome record** to its bucket (`_status/_outcome/…`) and ends with a step that
calls `/notify`. [`docs/slack-and-alerting.md`](../docs/slack-and-alerting.md) has the whole picture:
what a record holds, what posts where, the delivery guarantees, and how to diagnose a silent channel.
This is the Worker's half.

**`POST /notify`** (`src/oidc.ts`, `src/deliver.ts`) is open, like `/health`, but a request gets
through only with the caller's GitHub OIDC token (`Authorization: Bearer …`). The body is never read.
The token must:
- verify as RS256 against GitHub's JWKS. The keys are cached per isolate for 6 h, and an unknown
  `kid` refetches at most once a minute;
- carry `iss` `https://token.actions.githubusercontent.com` and an `aud` that includes
  `NOTIFY_AUDIENCE`;
- be inside `exp`/`nbf`/`iat`, with ±60 s of skew and a lifetime of 1 h at most;
- name a rostered `repository`, plus `repository_id` when the roster pins it;
- name a `job_workflow_ref` of
  `<ENGINE_REPO>/.github/workflows/{pg-backup,pg-durable-verify,pg-restore-drill,pg-archive}.yml@…`.
  That also says which job it is.

The Worker then lists that run's record by `run_id`, `run_attempt` and job, and delivers it. With no
record, it falls back to the Actions API: the job's failed step becomes a synthetic record, announced
as a failure.

| status | body | meaning |
| --- | --- | --- |
| 200 | `{ result, count }` | `posted` · `slack_off` (no Slack for this client; the webhook fired) · `already_posted` · `claimed_elsewhere` · `invalid` · `gave_up` · `no_outcome` (no record and no failed step) |
| 401 | `{ error: "unauthorized" }` | the token failed verification. The reason is in the Worker log |
| 403 | `not_rostered` · `repository_id` · `not_engine_workflow` · `bad_claims` | a valid token, but not for a rostered repo running an engine workflow |
| 405 | `method_not_allowed` | not a POST |
| 503 | `not_configured` · `{ result: "retry" }` · `internal` | `NOTIFY_AUDIENCE` unset or the roster invalid, or a transient failure. The caller's curl retries, and the Slack tick is behind it either way |

**The Slack tick** (`5,15,25,35,45,55 * * * *`, `slackTick` in `src/index.ts`) is its own invocation,
so Slack work never eats the main tick's subrequest budget. For each client it refreshes every
backup's daily row (`src/dailyRowStore.ts`). It also lists outcome records from the last 26 h that
nobody has announced and that are at least 3 minutes old. It then announces the oldest two across all
clients, looking at six at most. A tick-found record has no OIDC token behind it, so GitHub must
vouch for it first: `GET …/actions/runs/{id}` must exist, the run must be under 48 h old, and its
`referenced_workflows` must include the engine workflow for that job. Otherwise the record is marked
`rejected` and never posted. Once an hour the tick runs `auth.test` and writes the verdict to
`_scheduler/slack.json` for `/health`. The handler tells the two triggers apart by the minute they
were scheduled for (minute ≡ 5 mod 10), not by the cron string. Without the second trigger, rows stop
gaining ⬜ and a lost notify is never announced. `/health` reports that as `no Slack tick recorded`.

**Delivery state** lives on each record as R2 custom metadata: `gf-state`, `gf-at`, `gf-tries`,
`gf-error`. Every transition is a compare-and-swap on the object's etag. That gives:
- one post per record, even when a notify and a tick race for it;
- at-least-once delivery if the Worker dies mid-delivery;
- transient Slack errors retried once a 5-minute lease expires, up to three tries.

**The daily row** has one writer, the Worker, with a compare-and-swap on its state object
(`_status/<name>/<date>.json`). If `chat.update` can't edit the row (`cant_update_message`,
`message_not_found`), the Worker posts a new one and carries on. That is what happens on cutover day
(below).

**`GET /slack`** (behind `X-Trigger-Secret`) runs a Slack tick on demand and returns
`{ refreshed, announced, pending }`. It doesn't write `slack.json`, so hitting it by hand can't keep
`/health` green with the cron gone.

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
the watchdog's settings reach it via the bucket (see [Configuration](#configuration)). The same
permission covers the Slack side's reads of run and job metadata: vouching for a tick-found record,
and the failed-step fallback.

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
wrangler secret put SLACK_BOT_TOKEN            # the the-gitfather app's xoxb- token (optional; Slack off without it)
wrangler secret put ALERT_WEBHOOK_URL_ALPHA    # optional, per client: its failure webhook
npm run deploy
```

The Slack app is created once, from a manifest with `chat:write` + `chat:write.customize` and token
rotation off. The steps are in
[setting-up-gitfather.md → Appendix A](../docs/setting-up-gitfather.md#slack-the-gitfather-app-operator-only).
Invite the app to every roster channel before its first post.

Before a deploy, check that `wrangler.jsonc` has both cron triggers and `NOTIFY_AUDIENCE`, and that
every client that should post has a `slack` block. After it:

```sh
curl https://gitfather-scheduler.<subdomain>.workers.dev/health          # "slack": "ok" once the first Slack tick has run
curl -H "X-Trigger-Secret: $TRIGGER_SECRET" \
  https://gitfather-scheduler.<subdomain>.workers.dev/slack             # a Slack tick now: { refreshed, announced, pending }
npm run tail                                                           # "notify <id>: backup run … → posted" as runs finish
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
   `…/intraday/` object, a clean Slack tick, and a `HEARTBEAT_URL` ping. Then **unmute the dead-man's-switch**.

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

### Moving Slack into the Worker (from job-side Slack)

Before this version, each job posted to Slack with a bot token held in its repo's secrets. The
Worker's `SLACK_BOT_TOKEN` was one of those bots, so it couldn't edit a row another bot had posted.
The cutover is a clean break, with no job-side fallback. Every step leaves backups running, and at
worst Slack is quieter or later for a while.

1. **The app.** Create the the-gitfather app and invite it to every client channel
   ([Appendix A](../docs/setting-up-gitfather.md#slack-the-gitfather-app-operator-only)). Then run
   `wrangler secret put SLACK_BOT_TOKEN` with its token, and `wrangler secret delete` any
   `SLACK_BOT_TOKEN_<ID>`. Delete the `SLACK_BOT_TOKEN` secret from each client repo, so no repo holds
   a Slack token any more. Until step 4, Slack carries only the watchdog's pages.
2. **The Worker config**, in the infra repo's `wrangler.jsonc`:
   - give each roster entry a `slack` block (channel, username, icon) and a `repositoryId`;
   - add `"NOTIFY_AUDIENCE": "the-gitfather"`;
   - add the second cron, `"5,15,25,35,45,55 * * * *"`, which is one more of the account's five
     cron-trigger slots.

   If any repo sets `ALERT_WEBHOOK_URL`, copy its value to the Worker as `ALERT_WEBHOOK_URL_<ID>`.
3. **The consumer side.** Set the Actions variable `GITFATHER_NOTIFY_URL`
   (`https://<worker-host>/notify`) in every consumer repo. Remove `slack.channel` from each profile:
   the new engine **rejects** it, so a profile that still has it fails every job at config
   validation.
4. **Deploy and merge.** `npm run config:pull`, diff it against the live Worker, then `npm run deploy`
   from the engine branch. Then merge the engine. From here the jobs write outcome records. Until the
   callers change, the Slack tick posts them within ~10 minutes.
5. **The callers**, in each consumer repo:
   - grant `permissions: { contents: read, id-token: write }`;
   - pass `notify_url: ${{ vars.GITFATHER_NOTIFY_URL }}`;
   - drop `slack_channel`, `SLACK_BOT_TOKEN` and `ALERT_WEBHOOK_URL`, which the reusable workflows
     still declare as ignored no-ops so an older caller doesn't break.

   Runs now post within seconds. The repo's `SLACK_CHANNEL`, `SLACK_BOT_TOKEN` and
   `ALERT_WEBHOOK_URL` are no longer needed BY THE GITFATHER CALLERS; check the repo's other
   workflows before deleting them. A missing one mutes those workflows' alerts silently.

**Cutover day posts each client's row twice.** The old bots' rows can't be edited by the new app, so
the first tick after the switch gets `cant_update_message` and **re-posts that day's row once**.
From the next day there is one row per day again.

Validate with a `workflow_dispatch` of one backup. The row gets a 🖐️ ✅ tick under the roster
username and icon, and the tail shows `notify <id>: backup run … → posted`. For a failure, a bad
`FORCE_TIERS` should post ❌ plus a threaded page whose **job log** link opens that job.

## Endpoints

| Path                                  | Auth                  | Purpose                                   |
| ------------------------------------- | --------------------- | ----------------------------------------- |
| `GET /health`                         | open                  | liveness, incl. Slack (`"slack": "ok" \| "failing" \| "off"`); 503 when the cron or Slack is failing |
| `GET /health/jobs`                    | open                  | every client's job proofs; 503 if any owed one is missing or stale (`src/jobs.ts`) |
| `POST /notify`                        | GitHub OIDC token     | a finished job asks to be announced; see [Slack](#slack) |
| `GET /trigger?cadence=<c>&client=<id>`| `X-Trigger-Secret`    | manually fire one cadence (`client` opt.); `staleness` runs the watchdog and returns its outcomes |
| `GET /state`                          | `X-Trigger-Secret`    | return `_scheduler/state.json`            |
| `GET /slack`                          | `X-Trigger-Secret`    | run a Slack tick now (row refresh + announce unannounced outcomes); doesn't count for `/health` |

## Free-tier math

Workers Free: 100k req/day · 5 cron triggers/account · 10 ms CPU/invocation · 50 subrequests/invocation.
This Worker uses **2** cron triggers: 288 invocations a day, plus one `/notify` per finished job,
well under 1% of the request allowance. Every R2 binding call and every `fetch` is a subrequest, and
each invocation has its own 50:

- **The main tick.** It no longer touches the daily row. Per client, the watchdog makes ~5 on the
  fresh path: config list + get, intraday + legacy-prefix lists, and an alert-state get. It makes ~10
  when stale, adding a token mint, a run listing, one or two run-log reads, the dispatch, a page and
  the webhook. Each backup dispatch adds ~2 cold / ~1 warm.
- **The Slack tick.** About 4 per client: config list + get, the row's state, and the outcome
  listing. A row that gains a ⬜ adds 2 (update + put). On top of that come 2–3 fixed calls (the
  `slack.json` read/write, and hourly `auth.test`), and at most **2 announcements × ~10** (record
  get, GitHub vouch, claim, row get/update/put, up to three posts, webhook, posted mark). That cap is
  why a backlog drains at two per tick.
- **`/notify`.** About 15 at most per call: configs, the listing, the record, claim, row, posts,
  webhook, mark. It uses a couple more on the GitHub fallback, and the JWKS fetch on a cold isolate.

Budget for **about 5 clients** per Worker on the free plan. Beyond that, split the roster across
Workers or move to Workers Paid (10,000 subrequests). CPU is a few ms: one RS256 sign per cold mint,
one RS256 verify per `/notify`, and some Intl formatting. R2 binding reads and writes are in-network
and free. **Zero new charges**, and the Actions minutes the old watchdog burned (~4,300/month per
client) are gone.

[dispatch]: https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
