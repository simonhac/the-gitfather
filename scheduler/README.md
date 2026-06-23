# gitfather-scheduler

A single Cloudflare Worker that **replaces GitHub Actions cron** for the-gitfather. One Cron Trigger
(`*/10 * * * *`) wakes the Worker every 10 minutes; it works out which cadences are due and fires each
client's caller workflow via GitHub's REST [`workflow_dispatch`][dispatch] API.

Only the *trigger* moves. The backup, durable-verify, and **self-healing staleness watchdog** still run
inside GitHub Actions exactly as before — this Worker just dispatches them on a schedule.

```
*/10 tick ──▶ dueCadences(scheduledTime) ──▶ POST …/workflows/<file>/dispatches  (per client)
                                          └─▶ write _scheduler/state.json + log to the shared bucket
```

## Why this exists

GitHub Actions cron is best-effort: it drops/delays ticks and auto-disables scheduled workflows after
60 days of repo inactivity. Cloudflare Cron Triggers are cheaper to run and more punctual on average —
but they are **also** best-effort, so the real guarantee remains the staleness watchdog (self-heals a
missed backup) plus the external `HEARTBEAT_URL` dead-man's-switch (pages if backups stop entirely).

## Cadences

| Cadence         | When (UTC)        | Dispatches                | Input               |
| --------------- | ----------------- | ------------------------- | ------------------- |
| `staleness`     | every 10 min      | `pg-staleness-check.yml`  | —                   |
| `backup`        | every 2h (`:00`)  | `pg-backup.yml`           | `reason: schedule`  |
| `durableVerify` | daily `18:30`     | `pg-durable-verify.yml`   | —                   |
| `restoreDrill`  | manual only       | `pg-restore-drill.yml`    | —                   |

`durableVerify` must run **after** every client's `anchor-hour-utc` (so the day's `daily/` object exists
to verify). `18:30` suits anchor hours earlier in the day — adjust `dueCadences()` in `src/index.ts` if
yours is later. `restoreDrill` is superseded by `durableVerify`; fire it on demand via `/trigger`.

`backup` is dispatched with `reason: schedule` so it renders as a clean scheduled run (no 🖐️ marker) —
see `runOrigin()` in `../scripts/lib/schedule.ts`. The other callers take no inputs (extra keys → 422).

## Configuration

- **`wrangler.jsonc`** (gitignored) — copy from `wrangler.example.jsonc` and set the real shared
  dashboard bucket name. Nothing else here is secret.
- **Secrets** (`wrangler secret put …`, never committed):
  - `GH_APP_ID` — the GitHub App's id (the JWT `iss`). See [GitHub App setup](#github-app-setup).
  - `GH_APP_PRIVATE_KEY` — the App private key as a **PKCS#8** PEM (`-----BEGIN PRIVATE KEY-----`). GitHub
    issues PKCS#1; convert it **once** with `openssl pkcs8 -topk8 -nocrypt` (see below). The Worker signs a
    short-lived JWT with it and mints per-repo, 1h `actions:write` installation tokens — there is **no
    long-lived token to expire** (no silent-stop failure mode) and the blast radius is `actions:write` on the
    installed repos only.
  - `CLIENTS` — the roster JSON (below). Keeps repo names + installation ids out of the public source.
  - `TRIGGER_SECRET` — a random string gating `/trigger` and `/state`.

### `CLIENTS` roster

The caller-workflow filenames are identical across consuming repos by convention, so they're **defaults**
in the Worker (`DEFAULT_WORKFLOWS` in `src/index.ts`) — you don't repeat them per client. A client is its
`id` + `owner` + `repo` + the App's `installationId` on that owner:

```json
[
  { "id": "alpha", "owner": "your-org", "repo": "alpha-app", "installationId": 11111111 },
  { "id": "beta",  "owner": "your-org", "repo": "beta-app",  "installationId": 22222222, "cadences": ["backup", "staleness"] },
  { "id": "gamma", "owner": "other-org","repo": "gamma-app", "installationId": 33333333 }
]
```

- `id` — opaque label; the **only** client identifier that ever reaches the logs (the shared bucket is public).
- `installationId` — the App's installation id on this owner's account (see setup step 4). Not secret, but it
  rides in `CLIENTS` so the public source carries no owner/repo/install identifiers.
- `cadences` (optional) — restrict which cadences a client runs. Omit to run them all (the default).
  `beta` above opts out of `durableVerify`.
- `workflows` (optional) — per-client filename overrides, only if a client named a caller file differently,
  e.g. `"workflows": { "backup": "pg-backup-eu.yml" }`.

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
   Put each into its `CLIENTS` entry as `installationId`.

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
cp wrangler.example.jsonc wrangler.jsonc      # then set the real bucket_name
wrangler login                                 # or export CLOUDFLARE_API_TOKEN
wrangler secret put GH_APP_ID                   # the App ID (setup step 1)
wrangler secret put GH_APP_PRIVATE_KEY < app.pkcs8.pem  # multi-line: pipe the file in (the prompt only reads one line)
wrangler secret put CLIENTS                     # paste the roster JSON (with installationIds)
wrangler secret put TRIGGER_SECRET             # paste a random string
npm run deploy
```

## Cut over (cron-first)

Remove the GitHub cron **before** the Worker starts dispatching, so the two schedulers never overlap and
every run in your Actions history / Slack / dashboard is unambiguously Worker-originated — much simpler to
debug. The tradeoff: a short window with no scheduler (hence no self-heal) between removing cron and the
Worker's first tick. With only a few small backups that's fine — bridge it with a manual dispatch.

1. **(optional) mute the dead-man's-switch** for the maintenance window so the gap doesn't page.
2. In each client repo, delete the `schedule:` block from every caller — keep `workflow_dispatch:` and
   everything else verbatim:
   ```yaml
   on:
     schedule:                 # ← delete these two lines
       - cron: "0 */2 * * *"   # ←
     workflow_dispatch:        # keep
       inputs: { ... }         # keep (the backup caller's `reason` input is required by self-heal)
   ```
   Apply to `pg-backup.yml`, `pg-staleness-check.yml`, `pg-durable-verify.yml` (and `pg-restore-drill.yml`
   if present). **Do not** touch `name:` (the dashboard's `workflow_run` matches it) or `pg-dashboard.yml`
   (stays `workflow_run`). GitHub now schedules nothing.
3. **(optional) confirm dispatch still works** with cron gone, and avoid waiting up to 2h for the first
   backup: `gh workflow run pg-backup.yml -R your-org/alpha-app -f reason=schedule`.
4. **Deploy the Worker** (above). Its `*/10` cron is now the sole scheduler.
5. **Validate** — every run from here is Worker-originated:
   ```sh
   # Local sanity check: fire the scheduled handler and watch which cadences fan out
   npm run dev    # then open http://localhost:8787/__scheduled?cron=*/10+*+*+*+*

   # Live: tail logs in one terminal …
   npm run tail
   # … and dispatch one client/cadence in another (expect HTTP 204 in the tail)
   curl -H "X-Trigger-Secret: $TRIGGER_SECRET" \
     "https://gitfather-scheduler.<subdomain>.workers.dev/trigger?cadence=staleness&client=alpha"
   # Read back the latest scheduler state
   curl -H "X-Trigger-Secret: $TRIGGER_SECRET" \
     "https://gitfather-scheduler.<subdomain>.workers.dev/state"
   ```
   Confirm a `workflow_dispatch` run in each client's Actions tab, `_scheduler/state.json` in the shared
   bucket, and — on a `cadence=backup` dispatch — a new `…/2hourly/` object, a clean Slack tick, and a
   `HEARTBEAT_URL` ping. Then **unmute the dead-man's-switch**.

After this the Worker is the sole scheduler; the staleness watchdog (Worker-dispatched, self-heals inside
GitHub Actions) + `HEARTBEAT_URL` are the safety net. **Rollback:** re-add a `schedule:` block to a caller
and cron resumes within a tick.

## Endpoints

| Path                                  | Auth                  | Purpose                                   |
| ------------------------------------- | --------------------- | ----------------------------------------- |
| `GET /health`                         | open                  | liveness                                  |
| `GET /trigger?cadence=<c>&client=<id>`| `X-Trigger-Secret`    | manually fire one cadence (`client` opt.) |
| `GET /state`                          | `X-Trigger-Secret`    | return `_scheduler/state.json`            |

## Free-tier math

Workers Free: 100k req/day · 5 cron triggers/account · 10 ms CPU/invocation · 50 subrequests/request.
This Worker uses **1** cron trigger, **144** invocations/day (~0.15%), **≤ ~12 subrequests on a cold
busiest tick** (6 `workflow_dispatch` + up to 6 installation-token mints, dropping to ~6 once the
per-isolate token cache is warm), and sub-millisecond CPU (one RS256 sign per cold mint). R2 binding
reads/writes are in-network/free. Dispatch uses the same GitHub Actions minutes cron did. **Zero new charges.**

[dispatch]: https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
