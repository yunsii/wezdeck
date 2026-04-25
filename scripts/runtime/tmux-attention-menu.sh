#!/usr/bin/env bash
# Wrapper that opens the agent-attention picker in a centered tmux popup.
#
# Bound to M-/ from tmux.conf. Performance shape mirrors tmux-worktree-menu:
#   1. Read state.json + the live-panes.json snapshot (written by the
#      WezTerm-side `attention.overlay` handler one keystroke ago) here in
#      the *outer* shell, so the popup body never spends time on jq /
#      filesystem work.
#   2. Run the row-building jq pipeline once and write the resulting tuples
#      to a TSV prefetch file. picker.sh just slurps the file with bash
#      builtins.
#   3. Pre-render the very first frame to a tmp file using the shared
#      renderer. picker.sh's first action — before any sourcing — is to
#      write that frame to its own pty, so popup content lands within
#      milliseconds regardless of cold-cache lib-sourcing variance.
#   4. Toast and exit when there is nothing pending — no point opening a
#      popup just to display "no entries".
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/attention-state-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-attention/render.sh"

start_ms="$(runtime_log_now_ms)"
trace_id="$(runtime_log_current_trace_id)"

runtime_log_info attention "popup menu invoked" "trace=$trace_id"

attention_state_init
state_json="$(attention_state_read)"

raw_count="$(jq -r '.entries | length' <<<"$state_json" 2>/dev/null || printf '0')"
if [[ ! "$raw_count" =~ ^[0-9]+$ ]] || (( raw_count == 0 )); then
  tmux display-message -d 1500 'No pending agent attention'
  runtime_log_info attention "popup menu skipped — no entries" \
    "trace=$trace_id" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  exit 0
fi

now_ms="$(attention_state_now_ms)"

# Live pane → workspace / tab map: read the snapshot the WezTerm-side
# handler wrote on the same Alt+/ keystroke. >5s old (handler errored,
# stale leftover) falls back to '?' segments.
live_map='{}'
live_panes_path="$(attention_live_panes_path)"
if [[ -s "$live_panes_path" ]]; then
  snapshot_ts="$(jq -r '.ts // 0' "$live_panes_path" 2>/dev/null || printf '0')"
  [[ "$snapshot_ts" =~ ^[0-9]+$ ]] || snapshot_ts=0
  snapshot_age_ms=$((now_ms - snapshot_ts))
  if (( snapshot_age_ms >= 0 && snapshot_age_ms <= 5000 )); then
    if mapped="$(jq -c '.panes // {}' "$live_panes_path" 2>/dev/null)"; then
      [[ -n "$mapped" ]] && live_map="$mapped"
    fi
  fi
fi

# Build the per-row tuples once. Sort order matches the right-status
# counter in attention.lua (running → waiting → done) so the popup mirrors
# the badge order on the status bar at a glance.
#
# Row body and reason are sanitized so embedded \t / \n / \r cannot break
# the TSV split below (reason is user-facing string from the agent).
rows_tsv="$(jq -r \
  --argjson live "$live_map" \
  --argjson now "$now_ms" '
  def fmt_age($ms):
    (($ms / 1000) | floor) as $s
    | if $s < 60 then "\($s)s"
      elif (($s / 60) | floor) < 60 then "\((($s / 60) | floor))m"
      else "\((($s / 3600) | floor))h"
      end;
  def status_rank($s):
    if $s == "running" then 0
    elif $s == "waiting" then 1
    else 2 end;
  def strip_tmux_prefix($v):
    ($v // "") | tostring | sub("^[@%]"; "");
  def nonempty($v):
    ($v // "") | tostring | length > 0;
  def sanitize($s):
    ($s // "") | tostring | gsub("[\t\n\r]"; " ");

  .entries
  | to_entries | map(.value)
  | sort_by([status_rank(.status), (.ts // 0)])
  | map(
      . as $e
      | ($live[($e.wezterm_pane_id // "" | tostring)] // {}) as $L
      | (($now - (($e.ts // $now) | tonumber))) as $age_ms
      | (fmt_age($age_ms)) as $age_text_base
      | (if nonempty($e.wezterm_pane_id) then $age_text_base
         else "\($age_text_base), no pane" end) as $age_text
      | (if nonempty($L.workspace) then ($L.workspace | tostring) else "?" end) as $ws
      | (if (($L.tab_index // null) != null) then
           (if nonempty($L.tab_title)
              then "\($L.tab_index)_\($L.tab_title)"
              else "\($L.tab_index | tostring)" end)
         else "?" end) as $tab
      | (if nonempty($e.tmux_window) then
           (if nonempty($e.tmux_pane)
              then "\(strip_tmux_prefix($e.tmux_window))_\(strip_tmux_prefix($e.tmux_pane))"
              else strip_tmux_prefix($e.tmux_window) end)
         else "?" end) as $tmuxseg
      | (if nonempty($e.git_branch) then ($e.git_branch | tostring) else "?" end) as $branch
      | (if ($ws == "?" and $tab == "?" and $tmuxseg == "?" and $branch == "?")
           then null
           else "\($ws)/\($tab)/\($tmuxseg)/\($branch)" end) as $prefix
      | (if nonempty($e.reason) then ($e.reason | tostring) else $e.status end) as $reason
      | (if $prefix == null then $reason else "\($prefix)  \($reason)" end) as $body
      | "\($e.status)\t\(sanitize($body))\t\($age_text)\t\($e.session_id)"
    )
  | .[]
' <<<"$state_json" 2>/dev/null || printf '')"

if [[ -z "$rows_tsv" ]]; then
  tmux display-message -d 1500 'No pending agent attention'
  runtime_log_info attention "popup menu skipped — empty rows" \
    "trace=$trace_id" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  exit 0
fi

# Drop into parallel arrays for the in-process pre-render, AND mirror to a
# tmp TSV so picker.sh can re-build the same arrays via a single bash
# `read` loop without re-running jq inside the popup pty.
prefetch_file="$(mktemp -t wezterm-attention-picker.XXXXXX)"
row_status=()
row_body=()
row_age=()
while IFS=$'\t' read -r s b a id; do
  [[ -n "$s" ]] || continue
  row_status+=("$s")
  row_body+=("$b")
  row_age+=("$a")
  printf '%s\t%s\t%s\t%s\n' "$s" "$b" "$a" "$id" >> "$prefetch_file"
done <<<"$rows_tsv"

item_count="${#row_status[@]}"
if (( item_count == 0 )); then
  rm -f "$prefetch_file"
  tmux display-message -d 1500 'No pending agent attention'
  runtime_log_info attention "popup menu skipped — empty after parse" \
    "trace=$trace_id" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  exit 0
fi

# Append the destructive sentinel as the last row (TSV id = __clear_all__).
row_status+=("__sentinel__")
row_body+=("clear all · ${item_count} entries")
row_age+=("")
printf '%s\t%s\t%s\t%s\n' '__sentinel__' "clear all · ${item_count} entries" '' '__clear_all__' >> "$prefetch_file"
total_rows=$((item_count + 1))

# Pre-render the first frame. Geometry mirrors the `display-popup -w 80%
# -h 70%` invocation below (minus the 2-cell popup border on each axis).
# A small mismatch with picker.sh's stty-based render is invisible because
# the popup pty starts blank and both paint the same bytes.
prefetch_frame_file="$(mktemp -t wezterm-attention-frame.XXXXXX)"
client_width="$(tmux display-message -p '#{client_width}' 2>/dev/null || echo 100)"
client_height="$(tmux display-message -p '#{client_height}' 2>/dev/null || echo 30)"
popup_cols=$(( client_width * 80 / 100 - 2 ))
(( popup_cols < 20 )) && popup_cols=20
popup_rows=$(( client_height * 70 / 100 - 2 ))
(( popup_rows < 6 )) && popup_rows=6
visible_rows=$(( popup_rows - 4 ))
(( visible_rows < 1 )) && visible_rows=1

attention_picker_emit_frame "$popup_cols" "$visible_rows" 0 "$total_rows" > "$prefetch_frame_file"

picker_command="WEZTERM_RUNTIME_TRACE_ID=$(printf %q "$trace_id") bash $(printf %q "$script_dir/tmux-attention-picker.sh") $(printf %q "$prefetch_file") $(printf %q "$prefetch_frame_file")"

if tmux display-popup -x C -y C -w 80% -h 70% -T 'Agent attention' -E "$picker_command"; then
  rm -f "$prefetch_file" "$prefetch_frame_file"
  runtime_log_info attention "popup menu completed" \
    "trace=$trace_id" "duration_ms=$(runtime_log_duration_ms "$start_ms")" \
    "item_count=$item_count"
  exit 0
fi

rm -f "$prefetch_file" "$prefetch_frame_file"
runtime_log_warn attention "popup menu failed to launch" "trace=$trace_id"
tmux display-message 'Agent attention popup failed to launch'
exit 1
