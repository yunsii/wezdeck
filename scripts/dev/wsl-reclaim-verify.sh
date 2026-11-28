#!/usr/bin/env bash
set -euo pipefail
origin="${1:?missing web origin}"
check() {
  local name="$1"
  shift
  if "$@"; then
    printf '%s=ok\n' "$name"
  else
    printf '%s=failed\n' "$name" >&2
    return 1
  fi
}
check relay systemctl --user is-active --quiet wezdeck-relay.service
check otel systemctl --user is-active --quiet wezdeck-otel.service
check disk_guard systemctl --user is-active --quiet wezterm-disk-guard.timer
check tmux_restore_enabled systemctl --user is-enabled --quiet wezdeck-tmux-restore.service
check tmux_snapshot_timer systemctl --user is-active --quiet wezdeck-tmux-save.timer
check tmux_restore_result bash -c '[[ "$(systemctl --user show wezdeck-tmux-restore.service -p Result --value)" == success ]]'
check tmux_sessions bash -c 'tmux list-sessions -F "#{session_name}" | grep -q "^wezterm_"'
check tmux_snapshot test -s "${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/tmux-sessions.json"
env_file="$HOME/.config/shell-env.d/wezdeck-remote.env"
[[ -f "$env_file" ]] || exit 1
# The token stays in memory; never print it or the response body.
# shellcheck disable=SC1090
source "$env_file"
[[ -n "${WEZDECK_RELAY_HOST_TOKEN:-}" ]] || exit 1
if ! health="$(curl -fsS --max-time 8 -H "Authorization: Bearer $WEZDECK_RELAY_HOST_TOKEN" "$origin/relay/health")"; then
  printf 'web_health=failed\n' >&2
  exit 1
fi
if jq -e '.hosts_total >= 1 or .hosts >= 1' <<< "$health" >/dev/null; then
  printf 'web_host=ok\n'
else
  printf 'web_host=failed\n' >&2
  exit 1
fi
printf 'guest_used_bytes=%s\n' "$(df -B1 --output=used / | tail -n 1 | tr -d ' ')"
printf 'host_avail_bytes=%s\n' "$(df -B1 --output=avail /mnt/d | tail -n 1 | tr -d ' ')"
