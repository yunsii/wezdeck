#!/usr/bin/env bash
# Refresh a tmux copy-mode pane from its backing PTY while the user is
# browsing scrollback. Spawned by the `after-copy-mode` hook; exits as soon
# as the pane leaves copy-mode.

set -u

socket_path="${1:-}"
pane_id="${2:-}"
interval_ms="${3:-1000}"

if [[ -z "$socket_path" || -z "$pane_id" ]]; then
  exit 0
fi

tmux_cmd=(tmux -S "$socket_path")

tmux_option() {
  "${tmux_cmd[@]}" show-options -gqv "$1" 2>/dev/null || true
}

if [[ -z "$interval_ms" ]]; then
  interval_ms="$(tmux_option @copy_mode_auto_refresh_interval_ms)"
fi
case "$interval_ms" in
  ''|*[!0-9]*) interval_ms=1000 ;;
esac
(( interval_ms < 100 )) && interval_ms=100
(( interval_ms > 10000 )) && interval_ms=10000

sleep_s="$(awk -v ms="$interval_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"

history_guard_lines="$(tmux_option @copy_mode_auto_refresh_history_guard_lines)"
case "$history_guard_lines" in
  ''|*[!0-9]*) history_guard_lines=200 ;;
esac
(( history_guard_lines < 0 )) && history_guard_lines=0

prefetch_screens="$(tmux_option @copy_mode_auto_refresh_prefetch_screens)"
case "$prefetch_screens" in
  ''|*[!0-9]*) prefetch_screens=3 ;;
esac

option_enabled() {
  local value

  value="$(tmux_option @copy_mode_auto_refresh)"
  case "${value:-1}" in
    0|off|false|no|disabled) return 1 ;;
    *) return 0 ;;
  esac
}

copy_mode_active() {
  local state in_mode mode

  state="$("${tmux_cmd[@]}" display-message -p -t "$pane_id" '#{pane_in_mode} #{pane_mode}' 2>/dev/null || true)"
  [[ -n "$state" ]] || return 1

  in_mode="${state%% *}"
  mode="${state#* }"
  [[ "$in_mode" == "1" && "$mode" == copy-mode* ]]
}

selection_present() {
  local value

  value="$("${tmux_cmd[@]}" display-message -p -t "$pane_id" '#{selection_present}' 2>/dev/null || true)"
  [[ "$value" == "1" ]]
}

copy_mode_position() {
  "${tmux_cmd[@]}" display-message -p -t "$pane_id" '#{scroll_position} #{history_size} #{history_limit} #{pane_height}' 2>/dev/null || true
}

outside_prefetch_window() {
  local state scroll_position history_size history_limit pane_height threshold

  state="$(copy_mode_position)"
  [[ -n "$state" ]] || return 1

  read -r scroll_position history_size history_limit pane_height _ <<<"$state"
  case "$scroll_position:$pane_height" in
    *[!0-9:]*|:*|*:|*::*|*:::*) return 1 ;;
  esac
  (( scroll_position > 0 )) || return 1
  (( prefetch_screens > 0 )) || return 0

  threshold=$(( pane_height * prefetch_screens ))
  (( scroll_position > threshold ))
}

history_guard_active() {
  local state scroll_position history_size history_limit pane_height remaining

  (( history_guard_lines > 0 )) || return 1
  state="$(copy_mode_position)"
  [[ -n "$state" ]] || return 1

  read -r scroll_position history_size history_limit pane_height _ <<<"$state"
  case "$scroll_position:$history_size:$history_limit" in
    *[!0-9:]*|:*|*:|*::*|*:::*) return 1 ;;
  esac
  (( scroll_position > 0 )) || return 1
  (( history_limit > 0 )) || return 1

  remaining=$(( history_limit - history_size ))
  (( remaining <= history_guard_lines ))
}

safe_key="$(printf '%s__%s' "$socket_path" "$pane_id" | tr -c 'A-Za-z0-9._-' '_')"
lock_dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/wezterm-copy-mode-refresh"
mkdir -p "$lock_dir" 2>/dev/null || exit 0
lock_file="$lock_dir/$safe_key.lock"

exec 9>"$lock_file" 2>/dev/null || exit 0
if ! flock -n 9 2>/dev/null; then
  exit 0
fi

option_enabled || exit 0
copy_mode_active || exit 0

while sleep "$sleep_s"; do
  option_enabled || exit 0
  copy_mode_active || exit 0
  selection_present && continue
  # Server-global flag set by tmux-display-popup.sh while any overlay
  # is up. refresh-from-pane during the overlay races the client
  # composite and garbles CJK double-width cells into the popup.
  # Boolean only — concurrent popups are vanishingly rare; last closer
  # clears. Stuck flag after a hard kill: `tmux set -gu @wezterm_popup_active`.
  [[ "$(tmux_option @wezterm_popup_active)" == 1 ]] && continue
  outside_prefetch_window && continue
  history_guard_active && continue
  "${tmux_cmd[@]}" send-keys -t "$pane_id" -X refresh-from-pane 2>/dev/null || exit 0
done
