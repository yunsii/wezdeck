#!/usr/bin/env bash
# Antigravity CLI (agy) statusLine tap (docs/remote-sessions.md "Account limits").
#
# Agy pipes a JSON snapshot to its statusLine command on every state refresh
# (and periodically during long turns), including model quotas (quota.<bucket>:
# remaining_fraction, reset_time, reset_in_seconds), context_window, and
# optional plan_tier. Feed the same stdin here so wezdeck-wsl (remote_limits.go)
# can surface limits and context size on the web console:
#   - ~/.local/state/wezdeck/agy-status/<session_id>.json  (per-session snapshot)
#   - ~/.local/state/wezdeck/agy-status/_account.json      (latest account quota,
#     even before the first turn assigns a conversation_id)
# Written atomically, IDs validated, 30-day prune. No credentials, no API calls.
set -u

dir="${WEZDECK_AGY_STATUS_DIR:-$HOME/.local/state/wezdeck/agy-status}"
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
[ -n "$input" ] || exit 0

ts=$(date +%s)
payload=$(printf '%s' "$input" | jq -c --argjson ts "$ts" '
  select(type == "object")
  | {
      session_id: ((.conversation_id // .session_id // "") | tostring),
      ts: $ts,
      model: (.model.display_name // .model.id // null),
      model_id: (.model.id // null),
      plan_tier: (.plan_tier // null),
      context_window: (.context_window // null),
      quota: (.quota // null)
    }
' 2>/dev/null) || exit 0
[ -n "$payload" ] || exit 0

id=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
has_quota=$(printf '%s' "$payload" | jq -r 'if (.quota | type) == "object" and (.quota | length) > 0 then "1" else "" end' 2>/dev/null)

valid_id=0
case "$id" in
  '' | *[!A-Za-z0-9_-]*) valid_id=0 ;;
  *) valid_id=1 ;;
esac

if [ "$valid_id" -eq 0 ] && [ -z "$has_quota" ]; then
  exit 0
fi

mkdir -p "$dir" || exit 0

if [ "$valid_id" -eq 1 ]; then
  tmp="$dir/.$id.$$"
  if printf '%s\n' "$payload" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$dir/$id.json"
  else
    rm -f "$tmp"
  fi
fi

if [ -n "$has_quota" ]; then
  tmp="$dir/._account.$$"
  if printf '%s\n' "$payload" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$dir/_account.json"
  else
    rm -f "$tmp"
  fi
fi

# keep a month of per-session snapshots
find "$dir" -maxdepth 1 -name '*.json' ! -name '_account.json' -mtime +30 -delete 2>/dev/null
exit 0
