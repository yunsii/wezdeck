#!/usr/bin/env bash
# Inside display-popup body for Alt+x. Runs AFTER the overlay is already
# visible so bash prep no longer blocks "time to chrome".
#
# Args: <session_name> <base_tsv> <dispatch_sh> <picker_bin> <trace_id>
#        <menu_start_ts> [client_tty]
set -u

session_name="${1:-}"
base_tsv="${2:-}"
dispatch_script="${3:-}"
picker_binary="${4:-}"
trace_id="${5:-overflow}"
menu_start_ts="${6:-0}"
# client_tty reserved for future

if [[ ! -x "$picker_binary" ]]; then
  printf '\n  picker binary missing\n' >&2
  sleep 1
  exit 1
fi
if [[ ! -s "$base_tsv" ]]; then
  printf '\n  overflow cache empty — open a managed workspace first\n' >&2
  sleep 1
  exit 1
fi

current_workspace="$(tmux show-options -v -t "$session_name" @wezterm_workspace 2>/dev/null || true)"
[[ -n "$current_workspace" ]] || current_workspace="default"

# `session_activity` (epoch seconds — tmux's own "time of last activity in
# this session") rides along on the list-sessions format we already ran.
# It is the recency signal the picker sorts on; see the sort below.
existing_sessions="$(tmux list-sessions -F '#{session_name}'$'\t''#{session_activity}' 2>/dev/null || true)"
declare -A live_session_set=()
declare -A live_session_activity=()
while IFS=$'\t' read -r s s_activity; do
  [[ -n "$s" ]] || continue
  live_session_set["$s"]=1
  [[ "$s_activity" =~ ^[0-9]+$ ]] || s_activity=0
  live_session_activity["$s"]="$s_activity"
done <<< "$existing_sessions"

prefetch_file="$(mktemp -t wezterm-overflow-picker.XXXXXX)"
prefetch_aux="$(mktemp -t wezterm-overflow-picker-aux.XXXXXX)"
trap 'rm -f "$prefetch_file" "$prefetch_aux"' EXIT

while IFS=$'\t' read -r ws label cwd has_tab sess snap_idx tier score events recent; do
  [[ -n "$ws" && -n "$cwd" ]] || continue
  is_current=0
  [[ "$ws" == "$current_workspace" ]] && is_current=1
  state='cold'
  if [[ "$has_tab" == "true" ]]; then
    state='visible'
  elif [[ -n "$sess" && -n "${live_session_set[$sess]:-}" ]]; then
    state='warm'
  fi
  # Two-key recency: `live` splits rows that have a running tmux session
  # from rows that are only a config entry, and `activity_ms` orders
  # within each group. Live rows use tmux's own last-activity clock;
  # cold rows have no terminal at all, so they fall back to tab-stats'
  # `rank_recent_ms` (last sampled git change) purely to order themselves.
  live=0
  activity_ms=0
  if [[ -n "$sess" && -n "${live_session_activity[$sess]+set}" ]]; then
    live=1
    activity_ms=$(( ${live_session_activity[$sess]} * 1000 ))
  else
    [[ "$recent" =~ ^[0-9]+$ ]] && activity_ms="$recent"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ws" "$label" "$cwd" "$state" "$has_tab" "$is_current" "$sess" \
    "$snap_idx" "$tier" "$score" "$events" "$recent" "$live" "$activity_ms"
done < "$base_tsv" > "$prefetch_aux"

if [[ ! -s "$prefetch_aux" ]]; then
  printf '\n  no configured items\n' >&2
  sleep 1
  exit 0
fi

# One list across every workspace, most-recently-active first. The active
# workspace is NOT grouped on top any more — its own row is preselected
# instead (see initial_selected below), which is the same contract Alt+g
# has always had: the list tells you where the work is, the cursor tells
# you where you are.
#   -k13,13nr  live session before config-only row
#   -k14,14nr  last activity, newest first
#   -k1,1 / -k8,8n  stable tie-break (workspace name, snapshot order)
LC_ALL=C sort -t $'\t' \
  -k13,13nr -k14,14nr -k1,1 -k8,8n \
  "$prefetch_aux" \
  | awk -F '\t' 'BEGIN{OFS="\t"} {print $1,$2,$3,$4,$5,$6,$7}' \
  > "$prefetch_file"

# Preselect the row for the session this popup was opened from; fall back
# to the first row of the current workspace, then to the top row.
initial_selected="$(awk -F '\t' -v sess="$session_name" '
  sess != "" && $7 == sess && found == 0 { found = 1; row = NR - 1 }
  $6 == "1" && ws_hit == 0                { ws_hit = 1; ws_row = NR - 1 }
  END {
    if (found)       print row
    else if (ws_hit) print ws_row
    else             print 0
  }
' "$prefetch_file")"
[[ "$initial_selected" =~ ^[0-9]+$ ]] || initial_selected=0

menu_done_ts=$(( ${EPOCHREALTIME//./} / 1000 ))
keypress_ts=0

# Event dir for file-transport jumps (picker forces file). Inline default
# to avoid sourcing windows path libs inside the popup.
event_dir="${WEZBUS_EVENT_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/wezterm-events}"
mkdir -p "$event_dir" 2>/dev/null || true

export WEZTERM_RUNTIME_TRACE_ID="$trace_id"
export WEZTERM_EVENT_FORCE_FILE=1
export WEZBUS_EVENT_DIR="$event_dir"

exec "$picker_binary" overflow \
  "$prefetch_file" \
  "$dispatch_script" \
  "$keypress_ts" \
  "$menu_start_ts" \
  "$menu_done_ts" \
  "$initial_selected"
