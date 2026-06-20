#!/usr/bin/env bash
#
# Restore drill — proves the latest off-site R2 dump actually restores. The "0 restore errors" leg
# of 3-2-1-1-0; a backup isn't real until restored.
#
# Pulls the newest object under $BACKUP_PREFIX from R2, decrypts if needed, pg_restores it into a
# throwaway target, and asserts the restored sentinel-table row count is within tolerance of the
# live count (catches both a truncated dump and a stale/stuck backup). Best-effort Slack alert +
# non-zero exit on failure.
#
# Usage:
#   PROFILE=profiles/example.env bash scripts/restore-drill-pg.sh
#
# Required env (credentials — from GitHub secrets, NOT the profile):
#   R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   read access to the bucket
#   DRILL_DATABASE_URL        throwaway Postgres to restore into (e.g. the CI postgres:17 service)
#   PG_LIVE_DATABASE_URL      live DB — read-only, for the expected row count (usually = PG_BACKUP_DATABASE_URL)
# Optional env:
#   SLACK_BOT_TOKEN / SLACK_CHANNEL   one-off Slack post; ✅ on pass, 🔴 (mention) on failure
#   AGE_IDENTITY              age private key (file path or literal) — only if backups are .age
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${PROFILE:?set PROFILE to a profiles/*.env file}"
# shellcheck source=/dev/null
source "$PROFILE"
# shellcheck source=lib/slack.sh
source "$SCRIPT_DIR/lib/slack.sh"

: "${BACKUP_PREFIX:?profile must set BACKUP_PREFIX}"
: "${DRILL_SENTINEL_TABLE:?profile must set DRILL_SENTINEL_TABLE}"
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"
: "${DRILL_DATABASE_URL:?set DRILL_DATABASE_URL}"
: "${PG_LIVE_DATABASE_URL:?set PG_LIVE_DATABASE_URL}"

MIN_RATIO="${MIN_RATIO:-0.95}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

fail() { echo "ERROR: $1" >&2; slack_oneoff "🔴 PG restore-drill FAILED (${FILE_BASENAME:-pg}): $1" mention; alert_webhook "🔴 PG restore-drill FAILED (${FILE_BASENAME:-pg}): $1"; exit 1; }

command -v rclone     >/dev/null || fail "rclone not found"
command -v pg_restore >/dev/null || fail "pg_restore not found"
command -v psql       >/dev/null || fail "psql not found"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT"

# Best-effort verification record for the dashboard run-log (mirrors backup-pg-to-r2.sh).
runlog() {
  command -v npx >/dev/null 2>&1 || { echo "runlog: npx not found — skipping" >&2; return 0; }
  FILE_BASENAME="${FILE_BASENAME:-}" R2_BUCKET="$R2_BUCKET" \
    npx -y tsx "$SCRIPT_DIR/runlog.ts" "$@" || echo "runlog: non-fatal append failure" >&2
  return 0
}

# Expected object extension for this project's ENCRYPTION (mirrors backup-pg-to-r2.sh). Filtering the
# listing to it means a foreign/legacy object (e.g. a .dump.gz from a previous tool, or a half-written
# temp key) can never be selected and mask a real backup — the catch-all restore path below would just
# choke on it.
case "${ENCRYPTION:-none}" in
  none)    EXT="dump" ;;
  age)     EXT="dump.age" ;;
  aes-gcm) EXT="dump.enc" ;;
  *)       fail "unknown ENCRYPTION='${ENCRYPTION}'" ;;
esac

# Newest matching object across all tiers under the prefix. Keys are <tier>/<basename>-<stamp>.<ext>;
# sort by the FILENAME (the field after '/'), NOT the whole path — otherwise the leading tier dir
# dominates the sort (2hourly < daily < monthly < weekly) and we'd always pick the newest *weekly*
# rather than the newest overall. basename + ext are constant across candidates, so filename order ==
# stamp order == chronological.
echo "Finding newest .${EXT} object under r2:${R2_BUCKET}/${BACKUP_PREFIX}/ ..."
KEY="$(rclone lsf --files-only -R "r2:${R2_BUCKET}/${BACKUP_PREFIX}/" --s3-no-check-bucket 2>/dev/null \
  | grep -E "\.${EXT}$" | sort -t/ -k2 | tail -1 || true)"
[ -n "$KEY" ] || fail "no .${EXT} objects under ${BACKUP_PREFIX}/"
echo "Latest: ${BACKUP_PREFIX}/${KEY}"
rclone copyto "r2:${R2_BUCKET}/${BACKUP_PREFIX}/${KEY}" "$TMP/obj" --s3-no-check-bucket || fail "download failed"

# ── Decrypt / decompress to a plain custom-format dump ───────────────────────
DUMP="$TMP/restore.dump"
case "$KEY" in
  *.dump.age)
    command -v age >/dev/null || fail "object is .age but 'age' not found"
    [ -n "${AGE_IDENTITY:-}" ] || fail "object is .age but AGE_IDENTITY is unset"
    IDFILE="$TMP/id"; if [ -f "$AGE_IDENTITY" ]; then IDFILE="$AGE_IDENTITY"; else printf '%s' "$AGE_IDENTITY" > "$IDFILE"; fi
    age -d -i "$IDFILE" "$TMP/obj" > "$DUMP" || fail "age decrypt failed" ;;
  *.dump.enc)
    fail "object is aes-gcm encrypted but decrypt is not implemented yet (encryption is a planned follow-up)" ;;
  *.dump|*)
    cp "$TMP/obj" "$DUMP" ;;
esac

# ── Restore into the throwaway target ────────────────────────────────────────
# Restoring provider-managed schemas (e.g. auth/vault/storage on some managed Postgres platforms) into
# vanilla Postgres emits benign errors (missing roles/extensions); --disable-triggers (target is
# superuser) sidesteps cross-schema FK ordering.
# The row-count assertion below — not a clean restore — is the real gate.
echo "Restoring into the drill target ..."
pg_restore --no-owner --no-privileges --no-comments --disable-triggers -j 4 -d "$DRILL_DATABASE_URL" "$DUMP" \
  && echo "pg_restore: clean" || echo "pg_restore: completed with warnings (continuing to row-count check)"

restored() { psql "$DRILL_DATABASE_URL" -tAc "SELECT count(*) FROM public.$1" 2>/dev/null | tr -d '[:space:]' || true; }
live_est() { psql "$PG_LIVE_DATABASE_URL" -tAc "SELECT n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' AND relname='$1'" 2>/dev/null | tr -d '[:space:]' || true; }

SENT_RESTORED="$(restored "$DRILL_SENTINEL_TABLE")"
SENT_LIVE="$(live_est "$DRILL_SENTINEL_TABLE")"
echo "Sentinel public.${DRILL_SENTINEL_TABLE}: restored=${SENT_RESTORED:-?}  (live≈${SENT_LIVE:-?})"

{ [ -n "$SENT_RESTORED" ] && [ "$SENT_RESTORED" -gt 0 ]; } || fail "restored ${DRILL_SENTINEL_TABLE} is empty/zero"
{ [ -n "$SENT_LIVE" ] && [ "$SENT_LIVE" -gt 0 ]; }         || fail "could not read live ${DRILL_SENTINEL_TABLE} estimate"

# restored should be >= MIN_RATIO × live (allows rows added since the backup; catches truncation/staleness)
awk -v r="$SENT_RESTORED" -v l="$SENT_LIVE" -v m="$MIN_RATIO" 'BEGIN { exit !(r >= l*m) }' \
  || fail "restored ${DRILL_SENTINEL_TABLE} ${SENT_RESTORED} < ${MIN_RATIO}× live ${SENT_LIVE} — truncated or stale"

# Extra tables: simply non-empty.
for t in ${DRILL_EXTRA_TABLES:-}; do
  n="$(restored "$t")"
  echo "  extra public.${t}: restored=${n:-?}"
  { [ -n "$n" ] && [ "$n" -gt 0 ]; } || fail "restored ${t} is empty/zero"
done

echo "✓ Restore drill PASSED: public.${DRILL_SENTINEL_TABLE} ${SENT_RESTORED} ≥ ${MIN_RATIO}× live ${SENT_LIVE} (${KEY})"
slack_oneoff "✅ PG restore-drill OK (${FILE_BASENAME:-pg}) — ${DRILL_SENTINEL_TABLE} ${SENT_RESTORED} (≥${MIN_RATIO}× live ${SENT_LIVE}) — ${KEY}"

# Record the verification so the dashboard can mark that dump's cell as restore-verified. The dump
# stamp (YYYYMMDDTHHMMSSZ) embedded in the key maps to the matching run-log entry's ts.
DRILL_STAMP="$(printf '%s' "${KEY##*/}" | grep -oE '[0-9]{8}T[0-9]{6}Z' | head -1 || true)"
if [ -n "$DRILL_STAMP" ]; then
  VERIFIED_TS="${DRILL_STAMP:0:4}-${DRILL_STAMP:4:2}-${DRILL_STAMP:6:2}T${DRILL_STAMP:9:2}:${DRILL_STAMP:11:2}:${DRILL_STAMP:13:2}Z"
  RATIO="$(awk -v r="$SENT_RESTORED" -v l="$SENT_LIVE" 'BEGIN { if (l > 0) printf "%.4f", r / l }')"
  runlog verify --ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --verified-ts "$VERIFIED_TS" --ok true --ratio "$RATIO" || true
fi
