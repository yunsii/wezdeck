#!/usr/bin/env bash
set -euo pipefail
origin="${1:?missing web origin}"
systemctl --user is-active --quiet wezdeck-relay.service
systemctl --user is-active --quiet wezdeck-otel.service
systemctl --user is-active --quiet wezterm-disk-guard.timer
systemctl --user is-enabled --quiet wezdeck-tmux-restore.service
systemctl --user is-active --quiet wezdeck-tmux-save.timer
systemctl --user show wezdeck-tmux-restore.service -p Result --value | grep -qx success
tmux list-sessions -F '#{session_name}' | grep -q '^wezterm_'
[[ -s "${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/tmux-sessions.json" ]]
env_file="$HOME/.config/shell-env.d/wezdeck-remote.env"
[[ -f "$env_file" ]] || exit 1
# The token stays in memory; never print it or the response body.
# shellcheck disable=SC1090
source "$env_file"
[[ -n "${WEZDECK_RELAY_HOST_TOKEN:-}" ]] || exit 1
health="$(curl -fsS --max-time 8 -H "Authorization: Bearer $WEZDECK_RELAY_HOST_TOKEN" "$origin/relay/health")"
jq -e '.hosts_total >= 1 or .hosts >= 1' <<< "$health" >/dev/null
printf 'tmux=ok relay=active otel=active disk_guard=active web_host=connected\n'
