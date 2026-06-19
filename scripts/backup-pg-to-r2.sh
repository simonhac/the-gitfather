#!/usr/bin/env bash
#
# Off-site, provider-independent Postgres backup → Cloudflare R2, with GFS tiering.
#
# Dumps with `pg_dump -Fc` (custom format), optionally encrypts, and uploads to R2 via the S3 API
# (rclone). Each run writes one object to the 2hourly/ tier and then *promotes* (server-side R2→R2
# copy — no re-dump, no re-upload) that same object into daily/weekly/monthly when the run lands on
# the configured anchor. Retention is enforced by R2 lifecycle rules + bucket locks per prefix (set
# out-of-band; see README), not by this script. Built for GitHub Actions but runnable locally.
#
# Slack: one message per day that updates in place — a ✅/❌ + HH:MM tick per 2-hourly run (see
# scripts/lib/slack.sh). A failed run appends ❌ and posts a loud, mentioning threaded alert.
#
# Usage:
#   PROFILE=profiles/example.env bash scripts/backup-pg-to-r2.sh
#
# Required env (credentials — from GitHub secrets, NOT the profile):
#   PG_BACKUP_DATABASE_URL   postgres://USER:PW@HOST:5432/DB?sslmode=require
#                            ^ if your provider has a connection pooler, prefer its SESSION pooler
#                              (a transaction pooler can't run pg_dump).
#   R2_ACCOUNT_ID            endpoint = https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
#   R2_BUCKET                target bucket
#   R2_ACCESS_KEY_ID         R2 S3 access key id   (scoped: Object Read & Write, NO delete)
#   R2_SECRET_ACCESS_KEY     R2 S3 secret
# Optional env:
#   SLACK_BOT_TOKEN          xoxb-… (scope chat:write); enables the daily Slack status row
#   SLACK_CHANNEL            channel id (C…) to post the status row in
#   HEARTBEAT_URL            dead-man's-switch URL pinged on success (healthchecks.io etc.)
#   FORCE_TIERS              space-separated tier override for testing (e.g. "2hourly daily monthly")
#   AGE_RECIPIENT            age public key (only when ENCRYPTION=age)
#   DATABASE_BACKUP_ENCRYPTION_KEY / DATABASE_BACKUP_DATA_SALT  (only when ENCRYPTION=aes-gcm)
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
: "${PG_BACKUP_DATABASE_URL:?set PG_BACKUP_DATABASE_URL}"
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"

ENCRYPTION="${ENCRYPTION:-none}"
MIN_BYTES="${MIN_BYTES:-1048576}"
ANCHOR_HOUR_UTC="${ANCHOR_HOUR_UTC:-16}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_TS_ISO="${STAMP:0:4}-${STAMP:4:2}-${STAMP:6:2}T${STAMP:9:2}:${STAMP:11:2}:${STAMP:13:2}Z"  # ISO form of STAMP for the run-log
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
LABEL="$(TZ="${DISPLAY_TZ:-UTC}" date +%H:%M)"   # tick label in the Slack daily row

# rclone S3 remote configured purely from env (no rclone.conf on disk). Set early so fail() and the
# Slack daily-row state can reach R2 even if a failure happens before the upload.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT"

# Append one record to the private R2 run-log (the dashboard's source of truth). Best-effort: a
# logging hiccup must never fail the backup. Runs the shared TS via tsx (Node is present in CI and
# locally); FILE_BASENAME/R2_BUCKET are passed explicitly since the profile's vars aren't exported.
runlog() {
  command -v npx >/dev/null 2>&1 || { echo "runlog: npx not found — skipping" >&2; return 0; }
  FILE_BASENAME="$FILE_BASENAME" R2_BUCKET="$R2_BUCKET" \
    npx -y tsx "$SCRIPT_DIR/runlog.ts" "$@" || echo "runlog: non-fatal append failure" >&2
  return 0
}

case "$ENCRYPTION" in
  none)    EXT="dump" ;;
  age)     EXT="dump.age" ;;
  aes-gcm) EXT="dump.enc" ;;
  *)       echo "ERROR: unknown ENCRYPTION='$ENCRYPTION'" >&2; exit 1 ;;
esac
FILENAME="${FILE_BASENAME}-${STAMP}.${EXT}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/$FILENAME"

# On failure: record ❌ on today's row, then post a loud mentioning alert threaded under it. All
# best-effort — Slack problems must never mask the real error.
fail() {
  echo "ERROR: $1" >&2
  if slack_enabled; then
    local dayts
    dayts="$(slack_daily_record fail "$LABEL" 2>/dev/null || true)"
    slack_post "${SLACK_ALERT_MENTION:-<!here>} 🔴 *${FILE_BASENAME}* backup FAILED at ${LABEL} — $1" \
      "$dayts" true >/dev/null 2>&1 || true
  fi
  runlog run --ts "$RUN_TS_ISO" --ok false --error "$1" || true
  exit 1
}

command -v pg_dump >/dev/null || fail "pg_dump not found"
command -v rclone  >/dev/null || fail "rclone not found"

# ── Dump (+ optional encrypt) → $OUT ─────────────────────────────────────────
# shellcheck disable=SC2206
DUMP_FLAGS=( ${PG_DUMP_FLAGS:--Fc --no-owner --no-privileges} )

echo "Dumping Postgres → ${OUT} (ENCRYPTION=${ENCRYPTION}) ..."
case "$ENCRYPTION" in
  none)
    pg_dump "${DUMP_FLAGS[@]}" "$PG_BACKUP_DATABASE_URL" > "$OUT" \
      || fail "pg_dump failed" ;;
  age)
    command -v age >/dev/null || fail "ENCRYPTION=age but 'age' not found"
    : "${AGE_RECIPIENT:?ENCRYPTION=age requires AGE_RECIPIENT}"
    pg_dump "${DUMP_FLAGS[@]}" "$PG_BACKUP_DATABASE_URL" | age -r "$AGE_RECIPIENT" > "$OUT" \
      || fail "pg_dump | age pipeline failed" ;;
  aes-gcm)
    fail "ENCRYPTION=aes-gcm not implemented yet (encryption is a planned follow-up)" ;;
esac

SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "Dump size: $(( SIZE / 1024 / 1024 )) MB (${SIZE} bytes)"
[ "$SIZE" -ge "$MIN_BYTES" ] || fail "dump suspiciously small (${SIZE} < ${MIN_BYTES}) — not uploading"

# ── Which tiers does this run belong to? ─────────────────────────────────────
# Always 2hourly; the anchor-hour run is also daily, +weekly on Sun, +monthly on the 1st (UTC).
if [ -n "${FORCE_TIERS:-}" ]; then
  # shellcheck disable=SC2206
  TIERS=( $FORCE_TIERS )
else
  HOUR=$(date -u +%H); DOW=$(date -u +%u); DOM=$(date -u +%d)
  TIERS=( 2hourly )
  if [ "$((10#$HOUR))" -eq "$((10#$ANCHOR_HOUR_UTC))" ]; then
    TIERS+=( daily )
    [ "$DOW" = "7" ]        && TIERS+=( weekly )
    [ "$((10#$DOM))" -eq 1 ] && TIERS+=( monthly )
  fi
fi
echo "Tiers for this run: ${TIERS[*]}"

# Upload once to the first tier (always 2hourly), then server-side copy to the rest.
# Single-PUT (cutoff above dump size) is atomic — no multipart, no orphaned parts.
# R2 may log a benign "501 NotImplemented" for the x-amz-checksum-crc32 header the AWS SDK adds;
# rclone retries without it and the object lands — accept the one-line retry.
FIRST="${TIERS[0]}"
FIRST_KEY="${BACKUP_PREFIX}/${FIRST}/${FILENAME}"
echo "Uploading → r2://${R2_BUCKET}/${FIRST_KEY}"
rclone copyto "$OUT" "r2:${R2_BUCKET}/${FIRST_KEY}" \
  --s3-no-check-bucket --s3-upload-cutoff=4Gi --stats-one-line \
  || fail "R2 upload failed"

for TIER in "${TIERS[@]:1}"; do
  DEST_KEY="${BACKUP_PREFIX}/${TIER}/${FILENAME}"
  echo "Promoting → r2://${R2_BUCKET}/${DEST_KEY}"
  rclone copyto "r2:${R2_BUCKET}/${FIRST_KEY}" "r2:${R2_BUCKET}/${DEST_KEY}" \
    --s3-no-check-bucket --stats-one-line \
    || fail "R2 promotion copy to ${TIER} failed"
done

# Marker for the Slack row: which durable tiers this run was promoted to.
PROMOTED=""
for t in "${TIERS[@]}"; do [ "$t" = "2hourly" ] || PROMOTED+="${PROMOTED:+,}$t"; done
MARKER=""; [ -n "$PROMOTED" ] && MARKER="📅($PROMOTED)"

MB=$(( SIZE / 1024 / 1024 ))
echo "✓ Backup complete: ${FILENAME} (${MB} MB) → tiers: ${TIERS[*]}"
slack_daily_record ok "$LABEL" "$MARKER" >/dev/null || true
runlog run --ts "$RUN_TS_ISO" --ok true --tiers "${TIERS[*]}" --bytes "$SIZE" --key "$FIRST_KEY" || true

# Dead-man's-switch ping (success only) — its absence is the staleness signal.
if [ -n "${HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 "$HEARTBEAT_URL" >/dev/null 2>&1 || echo "warning: heartbeat ping failed" >&2
fi
