# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# Slack helpers for the backup tool — standalone (bash + curl + jq).
#
# Talks to the Slack Web API directly with the tool's OWN bot token (chat.postMessage /
# chat.update) — deliberately not coupled to any host app's Slack infra, so this stays portable.
# Sourced by the backup / drill / staleness scripts. All helpers are best-effort: if the bot token,
# channel, or jq are missing they no-op, and Slack failures never abort the caller.
#
# Reads from the environment / profile:
#   SLACK_BOT_TOKEN      xoxb-… (scope chat:write); unset → Slack disabled
#   SLACK_CHANNEL        channel id (C…) to post in
#   SLACK_ALERT_MENTION  mention prepended to loud alerts (default "<!here>")
#   DISPLAY_TZ           IANA tz for the daily row's date + HH:MM labels (default UTC)
#   FILE_BASENAME        names the per-day state object and the message header
#   R2_BUCKET + the RCLONE_CONFIG_R2_* exports set by the caller (for the daily-row state in R2)
# ─────────────────────────────────────────────────────────────────────────────

slack_enabled() {
  [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_CHANNEL:-}" ] && command -v jq >/dev/null 2>&1
}

# slack_api <method> <json-payload> → prints response body; returns 0 iff ok==true
slack_api() {
  local method="$1" payload="$2" resp
  resp="$(curl -fsS -m 15 -X POST "https://slack.com/api/${method}" \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data "$payload" 2>/dev/null || true)"
  printf '%s' "$resp"
  [ -n "$resp" ] && [ "$(printf '%s' "$resp" | jq -r '.ok // false' 2>/dev/null)" = "true" ]
}

# slack_post <text> [thread_ts] [broadcast=true|false] → prints the new message ts
slack_post() {
  slack_enabled || return 0
  local text="$1" thread="${2:-}" broadcast="${3:-false}" payload resp
  payload="$(jq -nc --arg ch "$SLACK_CHANNEL" --arg t "$text" --arg th "$thread" --argjson bc "$broadcast" '
    {channel:$ch, text:$t, unfurl_links:false, unfurl_media:false}
    + (if $th != "" then {thread_ts:$th, reply_broadcast:$bc} else {} end)')"
  resp="$(slack_api chat.postMessage "$payload")" || {
    echo "warning: slack chat.postMessage failed: $(printf '%s' "$resp" | jq -r '.error // "?"' 2>/dev/null)" >&2; return 1; }
  printf '%s' "$resp" | jq -r '.ts // empty'
}

# slack_update <ts> <text>
slack_update() {
  slack_enabled || return 0
  local ts="$1" text="$2" payload resp
  payload="$(jq -nc --arg ch "$SLACK_CHANNEL" --arg ts "$ts" --arg t "$text" \
    '{channel:$ch, ts:$ts, text:$t, unfurl_links:false, unfurl_media:false}')"
  resp="$(slack_api chat.update "$payload")" || {
    echo "warning: slack chat.update failed: $(printf '%s' "$resp" | jq -r '.error // "?"' 2>/dev/null)" >&2; return 1; }
}

# slack_oneoff <text> [mention]  — one-off post (drill / staleness); "mention" prepends the alert mention
slack_oneoff() {
  slack_enabled || return 0
  local text="$1"
  [ "${2:-}" = "mention" ] && text="${SLACK_ALERT_MENTION:-<!here>} ${text}"
  slack_post "$text" >/dev/null
}

# _rclone_try <rclone argv…> → echoes stdout and returns 0 on the first success; retries with backoff;
# returns non-zero only if all attempts fail. Lets callers tell "R2 unreachable" (non-zero) apart from
# "object genuinely absent" (a *successful* listing that simply doesn't contain the object).
_rclone_try() {
  local out attempt
  for attempt in 1 2 3; do
    if out="$(rclone "$@" 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
    [ "$attempt" -lt 3 ] && sleep "$((attempt * 2))"
  done
  return 1
}

# ── Daily status row ─────────────────────────────────────────────────────────
# One Slack message per DISPLAY_TZ day, persisted as _status/<basename>/<date>.json in R2 and
# updated in place. Each 2-hourly run records a ✅/❌ + HH:MM tick; the renderer also injects a ⬜
# placeholder for every *elapsed but empty* 2-hourly bucket, so a skipped/dropped run (GitHub Actions
# cron is best-effort) is visible as a gap rather than silently absent. Buckets mirror the dashboard
# heatmap: 12 two-hourly DISPLAY_TZ buckets, slot = floor(hour/2) (see lib/backupHistory.ts). If the cron
# cadence changes, update SLOTS_PER_DAY there and the bucket math here together.
_SLACK_DAILY_SLOTS=12   # 2-hourly buckets per DISPLAY_TZ day

# _slack_daily_keys → sets _SD_DATE_KEY / _SD_HEADER / _SD_KEY for the current DISPLAY_TZ day.
_slack_daily_keys() {
  local tz="${DISPLAY_TZ:-UTC}"
  _SD_DATE_KEY="$(TZ="$tz" date +%Y-%m-%d)"
  _SD_HEADER="*${FILE_BASENAME} DB backup — $(TZ="$tz" date '+%a %-d %b %Y') ($(TZ="$tz" date +%Z))*"
  _SD_KEY="_status/${FILE_BASENAME}/${_SD_DATE_KEY}.json"
}

# _slack_daily_load → echoes today's state JSON; returns 1 (caller should skip) if R2 is unreachable
# or the state is unreadable. For a genuinely-absent day it echoes a fresh state with ts="".
# A directory listing gives a clean exists/absent signal even on backends where `cat` of a missing
# object doesn't return a not-found exit code (rclone#7817). When in doubt, skip — a split row misleads
# and a missing tick is benign (the dump still landed; the heartbeat + staleness check still alert).
_slack_daily_load() {
  local listing state
  if ! listing="$(_rclone_try lsf --files-only "r2:${R2_BUCKET}/_status/${FILE_BASENAME}/" --s3-no-check-bucket)"; then
    echo "warning: cannot reach R2 to check today's Slack message — skipping Slack update this run" >&2
    return 1
  fi
  if printf '%s\n' "$listing" | grep -Fxq "${_SD_DATE_KEY}.json"; then
    state="$(_rclone_try cat "r2:${R2_BUCKET}/${_SD_KEY}" --s3-no-check-bucket)" \
      || { echo "warning: today's Slack state exists but is unreadable — skipping Slack update this run" >&2; return 1; }
    [ -n "$state" ] \
      || { echo "warning: today's Slack state is present but empty — skipping Slack update this run" >&2; return 1; }
  else
    state="$(jq -nc --arg d "$_SD_DATE_KEY" --arg h "$_SD_HEADER" '{channel:"",ts:"",date:$d,header:$h,entries:[]}')"
  fi
  printf '%s' "$state"
}

# _slack_daily_text <state> → renders the message text: header + real ticks (✅/❌) interleaved with
# ⬜ placeholders for elapsed-but-empty 2-hourly buckets, sorted by label.
_slack_daily_text() {
  local state="$1" tz="${DISPLAY_TZ:-UTC}"
  local date_key today cur_h s filled_buckets missing labels

  date_key="$(printf '%s' "$state" | jq -r '.date')"
  today="$(TZ="$tz" date +%Y-%m-%d)"
  cur_h="$(TZ="$tz" date +%H)"; cur_h=$((10#$cur_h))   # 0..23, base-10 (avoid octal on 08/09)

  # Buckets (0..11) already covered by a real run — slot = floor(HH/2) of the tick label.
  filled_buckets="$(printf '%s' "$state" | jq -r '[.entries[].label | (.[0:2]|tonumber) / 2 | floor] | unique | .[]')"
  _is_filled() { local b="$1" f; for f in $filled_buckets; do [ "$f" = "$b" ] && return 0; done; return 1; }

  # Collect canonical "HH:00" labels for buckets that are DUE (elapsed) yet EMPTY.
  labels=()
  for s in $(seq 0 $((_SLACK_DAILY_SLOTS - 1))); do
    # Due: any bucket on a past day, or a bucket whose start hour passed > ~1h ago today
    # (the +1 grace waits an hour into the bucket before calling a tardy GitHub run "missing").
    if [[ "$date_key" < "$today" ]]; then :
    elif [ "$date_key" = "$today" ] && [ $((2 * s + 1)) -le "$cur_h" ]; then :
    else continue; fi
    _is_filled "$s" && continue
    labels+=("$(printf '%02d:00' $((2 * s)))")
  done

  if [ ${#labels[@]} -eq 0 ]; then missing="[]"
  else missing="$(printf '%s\n' "${labels[@]}" | jq -R . | jq -sc .)"; fi

  printf '%s' "$state" | jq -r --argjson missing "$missing" '
    .header + "\n" + (
      ([ .entries[] | { label, sym: ((if .ok then "✅ " else "❌ " end) + .label + (if (.marker // "") != "" then " " + .marker else "" end)) } ]
       + [ $missing[] | { label: ., sym: ("⬜ " + .) } ])
      | sort_by(.label) | map(.sym) | join("  ·  "))'
}

# _slack_daily_persist <state> <create|refresh> → renders + posts (create) or updates (existing) the
# day's message, then saves state back to R2. In "refresh" mode with no existing message it stays
# quiet (no all-empty row). Echoes the message ts. Persists via a temp file + copyto (a sized PUT)
# rather than `rcat` (a stdin stream): R2 rejects the streaming-signature upload `rcat` issues with
# "NotImplemented". Without persisting, the day's ts is lost and the next run posts a duplicate row.
_slack_daily_persist() {
  local state="$1" mode="$2" text ts
  ts="$(printf '%s' "$state" | jq -r '.ts // empty')"
  [ -z "$ts" ] && [ "$mode" = "refresh" ] && return 0
  text="$(_slack_daily_text "$state")" || return 1
  if [ -z "$ts" ]; then
    ts="$(slack_post "$text")"
    [ -n "$ts" ] || { echo "warning: could not post daily slack message" >&2; return 1; }
    state="$(printf '%s' "$state" | jq -c --arg ts "$ts" --arg ch "$SLACK_CHANNEL" '.ts=$ts | .channel=$ch')"
  else
    slack_update "$ts" "$text" || true
  fi
  local state_file; state_file="$(mktemp)"
  printf '%s' "$state" > "$state_file"
  rclone copyto "$state_file" "r2:${R2_BUCKET}/${_SD_KEY}" --s3-no-check-bucket 2>/dev/null \
    || echo "warning: could not save slack daily state to R2" >&2
  rm -f "$state_file"
  printf '%s' "$ts"
}

# slack_daily_record <ok|fail> <HH:MM label> [marker] → records a tick on today's message
# (posting it if absent) and prints the day's message ts (for threading).
slack_daily_record() {
  slack_enabled || return 0
  local ok="$1" label="$2" marker="${3:-}" state okj
  _slack_daily_keys
  state="$(_slack_daily_load)" || return 0
  okj=false; [ "$ok" = "ok" ] && okj=true
  state="$(printf '%s' "$state" | jq -c --arg l "$label" --argjson okj "$okj" --arg m "$marker" \
    '.entries = ((.entries | map(select(.label != $l))) + [{label:$l, ok:$okj, marker:$m}])')" || return 1
  _slack_daily_persist "$state" create
}

# slack_daily_refresh → re-renders today's message in place (no new tick), so elapsed-but-empty
# buckets surface as ⬜ even when no backup ran. No-op if today has no message yet. Called by the
# hourly staleness check so a just-missed slot becomes visible within the hour.
slack_daily_refresh() {
  slack_enabled || return 0
  local state
  _slack_daily_keys
  state="$(_slack_daily_load)" || return 0
  _slack_daily_persist "$state" refresh
}
