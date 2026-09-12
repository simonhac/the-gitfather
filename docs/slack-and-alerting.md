# Slack, the failure webhook, and the dead-man's-switch

## Slack (optional)

Instead of one message per run (spam), the backup keeps **one message per day** and **updates it in
place** — a `✅`/`❌` + `HH:MM` tick per run, in the profile's `timezone`. A failed run appends `❌` and
posts a loud, `@here`-mentioning threaded alert whose `<basename> DB backup` title links to the dashboard
(`dashboard.url`) and whose error reason links to that run's GitHub Actions **job log** (falling back to the
run page, or plain text off-Actions). The staleness, restore-drill, and durable-verify failure pages share
this format. Any **elapsed-but-empty** slot renders as
`⬜ HH:00`, so a skipped run shows as a visible gap; the [Worker's watchdog](../scheduler/README.md) (every ~10 min)
re-renders the row so a just-missed slot surfaces within minutes. This needs a **bot token** (`chat.update`; incoming webhooks
can't update). "Today's message" is persisted as a tiny JSON object at `_status/<basename>/<date>.json`
in R2. If `SLACK_BOT_TOKEN`/`SLACK_CHANNEL` are unset, all Slack output is silently skipped.

**Failure webhook (no-bot fallback).** Separately from the bot, set `ALERT_WEBHOOK_URL` to get a
Slack-compatible `{"text":…}` POST on **failure only** (backup / restore-drill; the watchdog's copy is the Worker secret `ALERT_WEBHOOK_URL_<ID>`) — the simple
alerting path when you don't run a bot, or a redundant failure channel into a host app's existing
incoming webhook when you do. It can't update in place, so it fires on failures only (no per-run success
spam). Unset → no-op.

Setup: create a Slack app with the `chat:write` bot scope, install it, copy the `xoxb-…` token, invite
the bot to the channel, and set `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` — step by step in
[setting-up-gitfather.md → Appendix A](setting-up-gitfather.md#slack-bot-token-channel-id).

### Job-log link

Optional. The error-reason link resolves *this* run's per-job log page via the jobs
REST API, which needs the run's `GITHUB_TOKEN` to have **`actions: read`**. The reusable workflows pass
the token but **don't** request that scope themselves — a reusable workflow's `permissions:` is a *hard
requirement* on every caller, so requesting a scope the caller doesn't grant fails the run at startup
(`startup_failure`). The link is therefore best-effort: it resolves when the caller's token already has
`actions: read` (GitHub's *permissive* default) and otherwise falls back to the **run** page. On a
*restricted*-default repo, add `permissions: { contents: read, actions: read }` to the caller job (as
shown in the [caller examples](wiring-a-consuming-repo.md#2-add-the-caller-workflows-githubworkflows-in-your-repo))
to get the precise job-log link.

### Dead-man's-switch (optional, recommended)

The last line of defence, independent of both GitHub **and** the Cloudflare Worker. The Worker's
staleness watchdog already catches a backup not landing and pages from outside GitHub; this catches the
Worker itself being down. Create a **BetterStack heartbeat** (the fleet consolidated onto BetterStack
on 2026-09-11; healthchecks.io is decommissioned) with a period of ~8 h + grace ~1.5 h, and wire it to a **loud**
channel you actually watch (Slack with a mention, SMS/PagerDuty — not just an email that buries) — this is
the alert that fires when GitHub is the thing that's broken. Put its ping URL in `HEARTBEAT_URL`; the
backup pings it on success, so its absence pages independently of GitHub.

## Two heartbeats, not one

`HEARTBEAT_URL` and `VERIFY_HEARTBEAT_URL` are deliberately separate names, because they guard
different failures and one caller repo holds both:

| secret | pinged by | catches |
| --- | --- | --- |
| `HEARTBEAT_URL` | `pg-backup.yml`, on a successful dump+upload | the backup not landing at all |
| `VERIFY_HEARTBEAT_URL` | `pg-durable-verify.yml`, on a clean verify | dumps that land on schedule but **will not restore** |

If these ever collapsed into one name, a green backup would silence a broken restore — which is the
more dangerous of the two failures, because it looks healthy right up until you need it.

The verify ping's claim is **"these backups are provably restorable"**, which is far stronger than
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
