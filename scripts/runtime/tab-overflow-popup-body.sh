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

existing_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"
declare -A live_session_set=()
while IFS= read -r s; do
  [[ -n "$s" ]] && live_session_set["$s"]=1
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
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ws" "$label" "$cwd" "$state" "$has_tab" "$is_current" "$sess" \
    "$snap_idx" "$tier" "$score" "$events" "$recent"
done < "$base_tsv" > "$prefetch_aux"

if [[ ! -s "$prefetch_aux" ]]; then
  printf '\n  no configured items\n' >&2
  sleep 1
  exit 0
fi

LC_ALL=C sort -t $'\t' \
  -k6,6nr -k9,9nr -k10,10gr -k11,11nr -k1,1 -k8,8n \
  "$prefetch_aux" \
  | awk -F '\t' 'BEGIN{OFS="\t"} {print $1,$2,$3,$4,$5,$6,$7}' \
  > "$prefetch_file"

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
  "$menu_done_ts"
