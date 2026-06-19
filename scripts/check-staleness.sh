#!/usr/bin/env bash
#
# Staleness check — asserts a fresh backup has landed, self-heals a missed run, and keeps the Slack
# status row honest. Complements the backup script's dead-man's-switch ping: this one asserts an
# *object* actually landed (the literal "no new object in > STALE_HOURS"), the ping asserts a *run
# succeeded*. Together they also catch the workflow not firing.
#
# Lists the newest object under $BACKUP_PREFIX/2hourly/ and derives its age from the timestamped key.
# Each run it also refreshes today's Slack row (renders ⬜ for elapsed-but-empty 2-hourly buckets).
# If the newest object is older than STALE_HOURS it calls on_stale(): GitHub Actions cron is
# best-effort, so the default assumption is a *missed* tick and it re-triggers the backup once — but
# only when the last run succeeded (a *broken* backup is paged, not retried, to avoid an hourly
# trigger loop). See on_stale() for the full loop-safety rules.
#
# Usage:
#   PROFILE=profiles/example.env bash scripts/check-staleness.sh
#
# Required env: R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
# Optional env: SLACK_BOT_TOKEN / SLACK_CHANNEL  (🔴 mention on staleness; quiet when fresh)
#               GH_TOKEN / GITHUB_REPOSITORY     (self-heal: re-trigger the backup via `gh workflow run`)
#               SELF_HEAL=0  disable auto-retry (alert only)   DRY_RUN=1  log the trigger, don't fire
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${PROFILE:?set PROFILE to a profiles/*.env file}"
# shellcheck source=/dev/null
source "$PROFILE"
# shellcheck source=lib/slack.sh
source "$SCRIPT_DIR/lib/slack.sh"

: "${BACKUP_PREFIX:?profile must set BACKUP_PREFIX}"
: "${FILE_BASENAME:?profile must set FILE_BASENAME}"
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"

STALE_HOURS="${STALE_HOURS:-3}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
BACKUP_WORKFLOW="${BACKUP_WORKFLOW:-pg-backup.yml}"   # workflow to re-trigger on a missed run

fail() { echo "ERROR: $1" >&2; slack_oneoff "🔴 PG backup STALE (${FILE_BASENAME}): $1" mention; exit 1; }
note() { echo "$1" >&2; slack_oneoff "$1"; }   # quiet (no mention) — for self-heal progress

# on_stale <msg> — handle a stale newest backup. GitHub Actions cron is best-effort and routinely
# drops/delays a slot, so the default assumption is "a tick was MISSED" and we self-heal by
# re-triggering the backup. The one thing we must NOT do is hammer a genuinely BROKEN backup — so we
# only auto-retry when the last run succeeded (or none ran). Loop-safety, in order:
#   1. no gh / repo context → can't self-heal, page loudly.
#   2. a backup already queued/running → let it finish, don't pile up.
#   3. last run failed/cancelled/timed-out → broken, not missed → page loudly, do NOT retry.
#   4. otherwise (last ok or none) → trigger ONE catch-up backup, post a quiet note.
# Escalation needs no persistent state: if the catch-up itself fails, the *next* hourly check sees
# last-run=failure and takes path 3 (loud). At most one trigger per hourly invocation.
on_stale() {
  local msg="$1" inflight last
  echo "STALE: $msg" >&2

  if [ "${SELF_HEAL:-1}" != "1" ] || ! command -v gh >/dev/null 2>&1 || [ -z "${GITHUB_REPOSITORY:-}" ]; then
    fail "$msg"
  fi

  inflight="$(gh run list --workflow="$BACKUP_WORKFLOW" --limit 10 \
    --json status -q '[.[] | select(.status=="in_progress" or .status=="queued")] | length' 2>/dev/null || echo "")"
  if [ -n "$inflight" ] && [ "$inflight" != "0" ]; then
    note "🟡 PG backup STALE (${FILE_BASENAME}): $msg — a backup is already running; waiting it out."
    exit 0
  fi

  last="$(gh run list --workflow="$BACKUP_WORKFLOW" --limit 1 --json conclusion -q '.[0].conclusion // ""' 2>/dev/null || echo "")"
  case "$last" in
    failure|cancelled|timed_out|startup_failure)
      fail "$msg — last backup run \`${last}\`; not auto-retrying (backup looks broken, not missed)." ;;
  esac

  if [ "${DRY_RUN:-0}" = "1" ]; then
    note "🟡 [dry-run] PG backup STALE (${FILE_BASENAME}): $msg — would trigger a catch-up backup (last run \`${last:-none}\`)."
    exit 0
  fi
  if gh workflow run "$BACKUP_WORKFLOW" >/dev/null 2>&1; then
    note "🟡 PG backup STALE (${FILE_BASENAME}): $msg — triggered a catch-up backup (last run \`${last:-none}\`). Will page if it doesn't recover."
    exit 0
  fi
  fail "$msg — and the catch-up trigger (\`gh workflow run ${BACKUP_WORKFLOW}\`) failed."
}

command -v rclone >/dev/null || fail "rclone not found"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT"

NEWEST="$(rclone lsf --files-only "r2:${R2_BUCKET}/${BACKUP_PREFIX}/2hourly/" --s3-no-check-bucket 2>/dev/null | sort | tail -1 || true)"
[ -n "$NEWEST" ] || fail "no objects under ${BACKUP_PREFIX}/2hourly/"

# Filename: <FILE_BASENAME>-YYYYMMDDTHHMMSSZ.<ext>  → extract the stamp.
s="${NEWEST#"${FILE_BASENAME}-"}"; s="${s%%.*}"
if [ "${#s}" -lt 16 ]; then fail "cannot parse timestamp from '${NEWEST}'"; fi
plain="${s:0:4}-${s:4:2}-${s:6:2} ${s:9:2}:${s:11:2}:${s:13:2}"

# GNU date (CI runners) first, then BSD date (local macOS) fallback.
epoch="$(date -u -d "$plain UTC" +%s 2>/dev/null \
        || date -u -j -f "%Y-%m-%d %H:%M:%S" "$plain" +%s 2>/dev/null || true)"
[ -n "$epoch" ] || fail "cannot interpret timestamp '${plain}' from '${NEWEST}'"
now="$(date -u +%s)"
age_h=$(( (now - epoch) / 3600 ))
age_m=$(( (now - epoch) / 60 ))

# Refresh today's Slack status row every run (independent of freshness): re-renders ⬜ placeholders
# for elapsed-but-empty 2-hourly buckets, so a just-skipped slot becomes visible within the hour even
# if no backup has run since. No-op when today has no message yet.
slack_daily_refresh || true

echo "Newest 2hourly object: ${NEWEST} — ${age_h}h ${age_m}m old (threshold ${STALE_HOURS}h)"
[ "$age_h" -lt "$STALE_HOURS" ] \
  || on_stale "newest backup ${NEWEST} is ${age_h}h old (> ${STALE_HOURS}h)"

echo "✓ Fresh: newest backup is ${age_m}m old (< ${STALE_HOURS}h)"
