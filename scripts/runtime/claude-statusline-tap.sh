#!/usr/bin/env bash
# Claude Code statusLine tap (docs/remote-access.md "Account limits").
#
# Claude Code pipes a JSON snapshot to its statusLine command on every
# refresh, including the account's rate limits (rate_limits.five_hour /
# seven_day: used_percentage, resets_at) and the context window. Feed the
# same stdin here and the phone can show them: one file per session under
# ~/.local/state/wezdeck/claude-status/<session_id>.json, written atomically,
# read by wezdeck-wsl (remote_session.go). No credentials, no API calls.
#
# Hook it from the statusLine script, in the background so the status line
# never waits on it:
#   printf '%s' "$input" | bash "$WEZDECK_REPO/scripts/runtime/claude-statusline-tap.sh" >/dev/null 2>&1 &
set -u

dir="${WEZDECK_CLAUDE_STATUS_DIR:-$HOME/.local/state/wezdeck/claude-status}"
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
case "$id" in
  '' | *[!A-Za-z0-9-]*) exit 0 ;;
esac

mkdir -p "$dir" || exit 0
tmp="$dir/.$id.$$"
if printf '%s' "$input" | jq -c --argjson ts "$(date +%s)" \
  '{session_id, ts: $ts, model: .model.display_name, context_window, rate_limits}' \
  >"$tmp" 2>/dev/null; then
  mv -f "$tmp" "$dir/$id.json"
else
  rm -f "$tmp"
fi

# keep a month of snapshots
find "$dir" -name '*.json' -mtime +30 -delete 2>/dev/null
exit 0
