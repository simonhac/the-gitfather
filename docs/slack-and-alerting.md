# Slack, the failure webhook, and the dead-man's-switch

## How a run reaches Slack

The jobs don't talk to Slack. Only the [scheduler Worker](../scheduler/README.md) does, through one
**the-gitfather** Slack app whose bot token is a Worker secret. It exists nowhere else, and no client
repo holds a Slack token. A run reaches Slack in three steps:

1. **The job writes an outcome record.** Every backup, durable-verify, restore-drill and archive run
   writes one JSON object to its client's private bucket as it exits. That includes a clean finish,
   `fail()`, a config error, a crash, and a cancel or timeout. The key is
   `_status/_outcome/<YYYYMMDDTHHMMSSZ>_<runId>_<attempt>_<job>_<name>.json`
   ([`scripts/lib/jobOutcome.ts`](../scripts/lib/jobOutcome.ts), written by
   [`outcomeRecorder.ts`](../scripts/lib/outcomeRecorder.ts)). The record holds:
   - whether the run was `ok`, its exit code and its timing;
   - a per-job summary: tiers promoted, drill ratio, rows archived;
   - its alerts. Each is a `page` (a human must act) or a `warn` (a quiet note), with a code and a
     reason.

   A non-zero exit that recorded no reason still records a page (`exit_<code>`), so a crash is never
   announced as a success. The bucket's existing 14-day `_status/` lifecycle rule expires the records.
2. **The workflow tells the Worker.** Each reusable workflow ends with an `if: always()` step called
   *Notify the-gitfather scheduler*. It mints a GitHub OIDC token (audience `the-gitfather`) and
   `POST`s it to the Worker's `/notify`, at the URL the caller passes as
   `notify_url: ${{ vars.GITFATHER_NOTIFY_URL }}`. The caller grants
   `permissions: { contents: read, id-token: write }`, and nothing is stored. The step never fails the
   job. With no URL, no `id-token: write`, or a Worker that doesn't answer, it logs a warning and
   leaves the run to the Slack tick.
3. **The Worker announces it.** `/notify` checks the token against GitHub's published keys: issuer,
   audience and expiry. Its `repository` must match a roster entry, and so must its `repository_id`
   when the roster pins `repositoryId`. Its `job_workflow_ref` must be one of the engine's four
   reusable workflows, which also tells the Worker which job this is. The Worker then finds the record
   for the run id, attempt and job the **token** names, and posts it. It never reads the request body:
   everything it posts comes from R2 and the GitHub API.

**The Slack tick** is the Worker's second cron (`5,15,25,35,45,55 * * * *`), five minutes off the
main tick. It does three things:
- refreshes each daily row, so elapsed slots show ⬜ ([below](#the-daily-row));
- announces any outcome record nobody has announced yet;
- checks the token with `auth.test` once an hour.

That second job catches a notify that was lost, never sent, or failed half-way. It picks up records
from the last 26 hours that are at least 3 minutes old, oldest first, at most two per tick across all
clients. A record found this way has no token behind it, so it must be **vouched for** by GitHub
before it posts. The run must exist, be under 48 hours old, and have called the engine's workflow for
that job. Otherwise the record is marked `rejected` and never posted. So a record forged by someone
holding the client's R2 key, for a run that never happened, stays silent.

### Delivery guarantees

- **At least once.** Each record carries its delivery state in R2 custom metadata (`gf-state`: none →
  `claimed` → `posted`, or `invalid` / `rejected` / `gave_up`). Every transition is a compare-and-swap
  on the object's etag, so when a notify and a tick race for one record, only one of them posts it. A
  Worker that dies between posting and marking can repeat a message. That is deliberate: a duplicate
  beats a lost alert.
- **Seconds** when the notify arrives. **Within ~10 minutes** when it doesn't: the next Slack tick
  picks it up. The worst case is about 13 minutes, because a fresh record is left alone for 3 minutes
  so its own notify can arrive. It can be longer if more than two records are queued.
- **Slack errors.**
  - A *transient* error (rate limit, 5xx, network) leaves the record claimed. The tick retries it once
    the 5-minute lease expires, and gives up (`gave_up`) after three tries.
  - A *terminal* error (`not_in_channel`, `channel_not_found`, `invalid_auth`, …) is not retried. The
    record is marked `posted` with a `gf-error`, and the error goes to the Worker log. The failure
    webhook still fires. So a revoked token loses whatever runs finish while it is revoked, and
    `/health` flags it within the hour.
- **No record, no post.** A local run (no `GITHUB_RUN_ID`) writes no record, so it posts nothing. The
  same goes for archive `--dry-run=store` and `--target=local:` rehearsals.

### When a run leaves no record: the GitHub fallback

Some runs die before their script can write a record, for example in checkout, `npm ci` or tool
setup. Their notify step still runs, because it is `if: always()`. When `/notify` finds no record for
the run, it asks the Actions API, through the Worker's GitHub App, for the job's failed, cancelled or
timed-out step. It writes a synthetic record (`source: "github"`) for it and announces that like any
other failure: ``step "<name>" failure before the job recorded an outcome`` (or `cancelled` /
`timed_out`). The record is filed under the backup's name when the bucket publishes exactly one
config, and then the row also gets its ❌. Otherwise it is filed under the client id. A clean run that
recorded nothing (archive's `backfill_sizes`, say) posts nothing.

The fallback rides on the notify, because the tick only finds records. If a run fails in setup *and*
its notify is lost, nothing reaches Slack. The same is true of a runner that dies outright, since its
notify step never runs. Those cases are left to the out-of-band watchers below.

## What posts where

Everything goes to the client's roster channel: the `channel` of the `slack` block in its
[roster entry](../scheduler/README.md#roster-in-wranglerjsonc--vars). This is not a profile key.
Posts go out under that entry's `username` (default `<id> backup`) and its `iconEmoji` or `iconUrl`.
A client with no `slack` block gets no Slack at all; its failure webhook still fires.

| from | when | what | mention |
|---|---|---|---|
| backup | every run | a ✅/❌ `HH:MM` tick on the day's row, edited in place | — |
| backup | failure | 🔴 *`<name> DB backup`* FAILED at `HH:MM` — reason · job log. Threaded under the row and broadcast to the channel | yes |
| durable-verify | page alerts | one 🔴 `durable-verify FAILED` message: the reason, or a bullet per problem | yes |
| durable-verify | warn alerts (manual drill overdue, credential rotation) | one quiet ⚠️ message | — |
| restore-drill | pass / fail | a ✅ notice with the row ratio / a 🔴 page | on fail |
| archive | failure | 🔴 `archive FAILED` | yes |
| archive | refusals or anomalies only | 🟠 *needs attention*, a bullet each | yes |
| archive | a clean real run that did work | a quiet 🗄️ per-table summary. Nothing when there was nothing to do | — |
| GitHub fallback | no record, and a step failed | 🔴 `<job> FAILED` — `step "…" failure …` | yes |
| watchdog (main tick) | an overdue slot | a quiet 🟡 self-heal note, or a 🔴 `STALE` page (throttled by `staleness.repage-minutes`); later a 🟢 RECOVERED note | on STALE |
| Slack tick | a slot elapses empty | `⬜ HH:00` on the row | — |

The mention is the profile's `slack.alert-mention` (default `<!here>`), and it goes on pages only.
The Worker never takes a mention from anywhere else. The value must be one to four space-separated
tokens from `<!here>`, `<!channel>`, `<@U…>` and `<!subteam^S…>`. Config validation rejects anything
else, and the Worker reads any other published value as `<!here>`.

The `<name> DB backup` title links to `dashboard.url` when that is an https URL. **job log** links to
`https://github.com/<owner>/<repo>/actions/runs/<run>/job/<job>`. The Worker builds that from the run
id and the job id in the record, which the job reads from `GITFATHER_JOB_ID: ${{ job.check_run_id }}`.
Without a job id it falls back to the run page. No `GITHUB_TOKEN` or `actions: read` is involved.

Every piece of free text in a record is untrusted, because it came out of the client's bucket. That
covers reasons, table names and the run-log excerpt in a STALE page. It is escaped, capped and placed
in a code span inside a fixed template
([`slackText.ts`](../scripts/lib/slackText.ts), [`outcomeRender.ts`](../scheduler/src/outcomeRender.ts)).
See the [threat model](threat-model.md#threat-model).

### The daily row

Each backup keeps **one message per day**, edited in place, rather than one message per run. The
Worker is its only writer, and the row is in the profile's `timezone`:

- **A backup outcome** ticks `✅`/`❌` `HH:MM`, prefixed 🖐️ for a manual run or 🩹 for a self-heal,
  with 📅`DWM` for the tiers the run was promoted to.
- **The Slack tick** fills each elapsed-but-empty slot with `⬜ HH:00`, so a missed backup shows as a
  visible gap within ~10 minutes. A slot counts only once it has wholly elapsed.

The day is the one the run **started** in, so a backup that starts at 23:55 and notifies at 00:01
ticks yesterday's row. The row's state lives at `_status/<name>/<date>.json` in the client's bucket:
channel, message ts, entries, and the last text Slack accepted. An unchanged render makes no Slack
call. The day's first backup outcome creates the row, and a refresh never does.

Sometimes the Worker can't edit the row: another app posted it (the day of the cutover to the
the-gitfather app), someone deleted it, or the roster moved the client to another channel. The Worker
then posts a fresh row and carries on, so that day shows two rows. `chat.update` can't change a
message's sender, so a row keeps the name and icon it was posted with.

## The failure webhook

A client's Worker secret `ALERT_WEBHOOK_URL_<ID>` gets a Slack-compatible `{"text":…}` POST for every
**page**. The id is upper-cased, with non-alphanumerics turned into `_`. Pages cover job failures
(including the GitHub fallback), archive needs-attention, and the watchdog's STALE page. The webhook
can't update in place, so it never fires on success. It fires even when Slack is off for the client,
which makes it the no-Slack alerting path. It also works as a second failure channel into a host app's
existing incoming webhook. Jobs no longer read `ALERT_WEBHOOK_URL`, so a repo secret of that name does
nothing: move it to the Worker.

## Setting it up

Slack is set up once, by the operator, not per repo:
1. Create the the-gitfather app from a manifest with `chat:write` + `chat:write.customize`.
2. Invite it to each client's channel.
3. `wrangler secret put SLACK_BOT_TOKEN`.
4. Give each client a roster `slack` block.

Each consuming repo only sets the `GITFATHER_NOTIFY_URL` variable and grants `id-token: write`. Step
by step: [setting-up-gitfather.md → Appendix A](setting-up-gitfather.md#slack-the-gitfather-app-operator-only)
and the [scheduler README](../scheduler/README.md#configuration).

## When Slack shows nothing

Work outwards from the Worker:

1. **`GET /health`** on the Worker. `"slack": "failing"` comes with a reason:
   - `no Slack tick recorded`: the second cron trigger is missing from `triggers.crons`.
   - `Slack tick is stale`: the Slack tick has stopped running.
   - `Slack auth failing: invalid_auth` / `token_revoked`: the token was revoked, rotated or
     mistyped. Run `wrangler secret put SLACK_BOT_TOKEN`.

   `"slack": "off"` means the Worker has no token at all.
2. **The roster and the channel.** A client with no `slack` block has Slack off. An app that isn't in
   the channel gets `not_in_channel` on every post. `/health` does *not* show that, because `auth.test`
   proves only the token. Look for `not_in_channel` in `npm run tail`, then `/invite` the app.
3. **The job log.** The main step ends with `outcome: recorded ok|FAILED → _status/_outcome/…`, or
   says why it didn't record (`outcome: not recorded (…)`, `outcome: cannot record: …`). The *Notify
   the-gitfather scheduler* step prints `scheduler /notify → <status>`, and the reason is in the
   Worker log:
   - `200`: handled.
   - `401`: the Worker rejected the token.
   - `403`: one of `not_rostered` (the repo's `owner/repo` isn't in the roster), `repository_id`
     (the roster's `repositoryId` doesn't match), or `not_engine_workflow` (a fork's workflow; set
     `ENGINE_REPO`).
   - `503`: `NOTIFY_AUDIENCE` is unset, or a transient failure.

   A warning that the caller didn't grant `id-token: write`, or didn't set `notify_url`, means the
   tick will post the run within ~10 minutes.
4. **The record's delivery state.** `rclone lsjson -M r2:<bucket>/_status/_outcome/` lists each
   record's `gf-state`:
   - `posted`: done. A `gf-error` beside it means Slack refused the post.
   - `claimed`: in flight, or waiting out a transient error.
   - `rejected`: GitHub didn't vouch for the run. It is older than 48 hours, isn't a run of the
     engine workflow, or doesn't exist.
   - `invalid`: not a well-formed record.
   - `gave_up`: three transient failures.

   `curl -H "X-Trigger-Secret: …" https://<worker>/slack` runs a Slack tick now and returns what it
   announced.
5. **No record and no notify.** The run probably never started: a dispatch that failed, a lapsed
   Actions billing, an invalid workflow. Nothing in Slack can report that. It is left to the watchdog's
   STALE page for backups, `/health/jobs` for verify and archive, and the heartbeats. Check the
   client's Actions tab and the Worker's `/state`.

## Dead-man's-switch (optional, recommended)

The last line of defence, independent of both GitHub **and** the Cloudflare Worker. The Worker's
staleness watchdog already catches a backup not landing and pages from outside GitHub. This catches
the Worker itself being down, and because the Worker is now the only thing that posts to Slack, a dead
Worker also means a silent channel. Create a **BetterStack heartbeat** with a period of ~8 h and a
grace of ~1.5 h (the fleet consolidated onto BetterStack on 2026-09-11; healthchecks.io is
decommissioned). Wire it to a **loud** channel you actually watch: Slack with a mention, SMS or
PagerDuty, not just an email that gets buried. This is the alert that fires when GitHub is the thing
that's broken. Put its ping URL in `HEARTBEAT_URL`. The backup pings it on success, so its absence
pages independently of GitHub. Point an uptime monitor at the Worker's `/health` too (see below).

## Job proofs: one monitor for every job

A pushed heartbeat per job per project doesn't scale, and it fails silently. Three projects times
(backup, verify) plus the scheduler used up all ten heartbeats on Better Stack's free plan before
the archiver got one. Each ping URL is also an optional secret the caller has to pass explicitly, so
a job that was never wired looks exactly like one that opted out. Better Stack adds a second trap: a
heartbeat that has never had a first beat sits in `pending` and **cannot alert**. CB-299 found four
stuck there for twelve days, with green jobs underneath.

So the jobs after the backup **publish a proof instead of pinging**. At exactly the point they would
have pinged, and behind the same gate, they write `_health/<name>/<job>.json` to their own bucket.
The scheduler Worker already binds every client's bucket, so it reads all of the proofs and serves
them at **`GET /health/jobs`**. It returns 503 when any owed proof is missing, stale, or can't be
read (see [`scripts/lib/jobProof.ts`](../scripts/lib/jobProof.ts)).
**One uptime monitor on that URL covers every job in every project**, and adding a project costs
nothing.

| proof | written by | when | stale after |
| --- | --- | --- | --- |
| `durableVerify` | `verify-durable-pg.ts` | the verify verdict below allows it | 30 h — one missed daily run |
| `archive` | `archive-table.ts` | a clean real run that met its [floor](archiving.md#the-floor-a-run-that-owed-work-must-do-it) | 8 days — one missed Monday |

A client owes a proof for each cadence the roster subscribes it to. The `archive` proof is also
skipped for a database whose published config says it archives nothing. A proof that has **never
been written is red**, not `pending`, so a caller that isn't wired up shows immediately. Zero owed
proofs is also red, because nothing was checked.

Point a Better Stack **status** monitor (it expects a 2xx) at `https://<worker>/health/jobs`, and
a second one at `/health` for the scheduler itself. The body carries opaque client ids, job names
and ages only.

## The push heartbeats that remain

`HEARTBEAT_URL` and `VERIFY_HEARTBEAT_URL` are still supported. `HEARTBEAT_URL` stays the backup's
switch because it is independent of both GitHub and the Worker. The two names are deliberately
separate because they guard different failures, and one caller repo can hold both:

| secret | pinged by | catches |
| --- | --- | --- |
| `HEARTBEAT_URL` | `pg-backup.yml`, on a successful dump+upload | the backup not landing at all |
| `VERIFY_HEARTBEAT_URL` | `pg-durable-verify.yml`, on a clean verify | dumps that land on schedule but **will not restore** — now also covered by the `durableVerify` proof |

If the two names were merged, a green backup would silence a broken restore. That is the more
dangerous failure, because it looks healthy right up until you need it. Both are off when unset, and
a reusable workflow can't tell "unset" from "opted out", so after wiring one, confirm it leaves
`pending`.

The verify proof's (and ping's) claim is **"these backups are provably restorable"**, which is far stronger than
"the job exited 0", so the gate is correspondingly strict (`scripts/lib/verifyHeartbeat.ts`):

| blocks the ping | why |
| --- | --- |
| any failed check | hash mismatch, restore gate, census floor |
| a failed tier listing | a partial listing makes the census floor meaningless |
| no durable objects | nothing to make a claim about |
| `pg_restore`/`psql` missing | restorability was never tested — this only *warns* in the run |
| `fresh:false` **and** `aged:false` | no restore leg enabled |
| `max-restores: 0` | restores disabled |
| no restore this run **and** none on record | nobody has proved these restore lately |

The distinction that matters is **"nothing was DUE"** (healthy — a recent object already carries a
successful restore) versus **"nothing was POSSIBLE"** (not healthy — nobody checked). Only the first
pings. An earlier version required just `failures === 0` and a non-empty listing, and every row in
that table above was a green heartbeat claiming restorability nobody had established.

Credential-rotation warnings do not withhold the verify ping: key age is advisory, not a statement
about whether these backups restore.
