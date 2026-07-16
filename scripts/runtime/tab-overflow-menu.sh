#!/usr/bin/env bash
# Cross-workspace tab-overflow picker. Bound to user-key User4 (Alt+x).
#
# Enumerates `<state>/tab-stats/*-items.json` (one snapshot per workspace
# that has been opened under tab_visibility), tags each item with its
# current state (visible / warm / cold) computed from live tmux sessions,
# joins each row against the per-workspace activity stats so we can rank
# by where real git work happened, and pops a popup
# picker listing every row across every workspace. The active workspace's
# rows still group at the top; within and across workspaces the rows the
# user works in most often sort first. Stats accumulate over time — the
# first-ever popup before any activity events fall back to `workspaces.lua`
# declared order via the snap_idx tiebreaker.
#
# Selection routes through tab-overflow-dispatch.sh exactly as before:
#   visible  → tab.activate_visible event
#   warm     → switch overflow pane to that session + tab.activate_overflow
#   cold     → tab-overflow-cold-spawn.sh + same warm path
# Cross-workspace picks add a `tab.cross_workspace_focus` event sent
# beforehand so the lua side calls SwitchToWorkspace on the gui window
# (the dispatch event itself is mux-keyed and would otherwise leave the
# gui foregrounded on the previous workspace).
#
# Empty-state handling:
#   - No snapshots at all → toast "open a workspace first".
#   - Every snapshot empty → toast "no configured items".

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/tab-stats-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/wezterm-event-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/tmux-worktree-lib.sh" 2>/dev/null || {
  tmux_worktree_session_name_for_path() { :; }
}

# Capture menu-side timestamps for the perf footer (lua + menu + picker).
menu_start_ts=$(( ${EPOCHREALTIME//./} / 1000 ))
start_ms=$menu_start_ts
trace_id="overflow-$EPOCHSECONDS-$$-$RANDOM"

session_name="${1:-}"
client_tty="${2:-}"

if [[ -z "$session_name" ]]; then
  session_name="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"
fi

current_workspace="$(tmux show-options -v -t "$session_name" @wezterm_workspace 2>/dev/null || true)"
if [[ -z "$current_workspace" ]]; then
  current_workspace="default"
fi

stats_dir="$(tab_stats_dir)"
shopt -s nullglob
snapshots=( "$stats_dir"/*-items.json )
shopt -u nullglob

if (( ${#snapshots[@]} == 0 )); then
  tmux display-message -d 3000 \
    "Overflow picker: no workspace items snapshot yet (open a workspace under tab_visibility first)"
  exit 0
fi

# Snapshot tmux sessions once so the warm/cold compute is O(N) instead of
# O(N) `tmux has-session` forks.
existing_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"

# Build per-workspace TSV blocks then concatenate. After all blocks are
# emitted we sort the union by `is_current desc, activity tier desc, score desc,
# event_count desc, snap_idx asc` so:
#   1. The current workspace's rows stay grouped at the top.
#   2. Within each block the rows where git activity happened most
#      often surface first — a session changed by shell/git/agent work
#      beats one that was merely viewed.
#   3. Cross-workspace rows interleave by activity score (a heavy A row sits
#      above a light B row regardless of workspace). Workspace identity
#      stays visible via the workspace badge column the picker renders.
#   4. Snapshot index is the within-workspace tiebreaker so ties on
#      activity score (e.g. cold-start workspace where every score is 0) fall
#      back to the user's intended `workspaces.lua` order — the picker
#      stays usable before any activity stats accumulate.
# Aux columns 8-12 (snap_idx, rank_tier, rank_score, event_count, rank_recent_ms) carry
# the sort keys; an awk pass strips them before writing the prefetch_file
# the Go picker reads (the picker still expects a 7-column TSV).
prefetch_file="$(mktemp -t wezterm-overflow-picker.XXXXXX)"
prefetch_aux="$(mktemp -t wezterm-overflow-picker-aux.XXXXXX)"
trap 'rm -f "$prefetch_file" "$prefetch_aux"' EXIT

declare -a other_workspaces=()

for snapshot in "${snapshots[@]}"; do
  ws="$(jq -r '.workspace // ""' "$snapshot" 2>/dev/null || true)"
  if [[ -z "$ws" ]]; then
    # Fallback: derive from filename slug if the snapshot was written
    # before the workspace field existed.
    base="${snapshot##*/}"
    ws="${base%-items.json}"
  fi
  if [[ "$ws" == "$current_workspace" ]]; then
    continue  # written first below
  fi
  other_workspaces+=("$ws")
done

# Deduplicate the other-workspaces list. Order doesn't matter for the
# user — it's just enumeration order before per-workspace weight maps
# get built. The final picker order is decided by the sort below.
if (( ${#other_workspaces[@]} > 0 )); then
  IFS=$'\n' read -r -d '' -a other_workspaces < <(
    printf '%s\n' "${other_workspaces[@]}" | LC_ALL=C sort -u
    printf '\0'
  )
fi

# Per-session activity maps — keyed by base session name (suffixes like
# `__refresh_<ts>_<pid>` aggregated upstream by tab_stats_aggregated_tsv,
# matching the lua-side rank_sessions normalization). Session names are
# workspace-prefixed (`wezterm_<slug>_<repo>_<10hex>`), so a single flat
# map is collision-free across workspaces.
declare -A score_for_sess
declare -A tier_for_sess
declare -A event_count_for_sess
declare -A recent_for_sess

populate_weights_for_workspace() {
  local target_ws="$1"
  local base rank_tier rank_score total_dwell_ms event_count rank_recent
  # tab_stats_aggregated_tsv emits 6 columns:
  #   <base>\t<rank_tier>\t<rank_score>\t<total_dwell_ms>\t<event_count>\t<rank_recent_ms>
  # Picker sorts by tier, then rank_score; total_dwell_ms is read so
  # the surface is wired up for future "lifetime focus" picker chips
  # without a second pass through this populator.
  while IFS=$'\t' read -r base rank_tier rank_score total_dwell_ms event_count rank_recent; do
    [[ -n "$base" ]] || continue
    : "$total_dwell_ms"  # parsed for future use, intentionally unused for now
    tier_for_sess["$base"]="$rank_tier"
    score_for_sess["$base"]="$rank_score"
    event_count_for_sess["$base"]="$event_count"
    recent_for_sess["$base"]="$rank_recent"
  done < <(tab_stats_aggregated_tsv "$target_ws" 2>/dev/null)
}

populate_weights_for_workspace "$current_workspace"
for ws in "${other_workspaces[@]}"; do
  populate_weights_for_workspace "$ws"
done

emit_workspace_rows() {
  local target_ws="$1"
  local target_snapshot="$stats_dir/$(tab_stats_workspace_slug "$target_ws")-items.json"
  [[ -f "$target_snapshot" ]] || return 0
  local is_current=0
  [[ "$target_ws" == "$current_workspace" ]] && is_current=1
  local snap_idx=0
  while IFS=$'\t' read -r cwd label has_tab; do
    [[ -n "$cwd" ]] || continue
    snap_idx=$(( snap_idx + 1 ))
    local state='cold'
    # Compute the canonical session name unconditionally so we can
    # always look up its weight, regardless of whether the tmux session
    # is currently alive (visible/warm) or not (cold). The function is
    # deterministic on workspace+cwd.
    local sess
    sess="$(tmux_worktree_session_name_for_path "$target_ws" "$cwd" 2>/dev/null || true)"
    if [[ "$has_tab" == "true" ]]; then
      state='visible'
    elif [[ -n "$sess" ]] && grep -Fxq "$sess" <<<"$existing_sessions" 2>/dev/null; then
      state='warm'
    fi
    local rank_tier="${tier_for_sess[$sess]:-0}"
    local rank_score="${score_for_sess[$sess]:-0}"
    local event_count="${event_count_for_sess[$sess]:-0}"
    local rank_recent="${recent_for_sess[$sess]:-0}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$target_ws" "$label" "$cwd" "$state" "$has_tab" "$is_current" "$sess" \
      "$snap_idx" "$rank_tier" "$rank_score" "$event_count" "$rank_recent" \
      >> "$prefetch_aux"
  done < <(jq -r '.items[] | [.cwd, .label, (.has_tab // false | tostring)] | @tsv' "$target_snapshot" 2>/dev/null)
}

emit_workspace_rows "$current_workspace"
for ws in "${other_workspaces[@]}"; do
  emit_workspace_rows "$ws"
done

# Sort by:
#   k6 (is_current) desc → current workspace block stays at top
#   k9 (rank tier) desc — real git activity outranks passive viewing
#   k10 (rank score) desc — activity score or same-tier dwell fallback
#   k11 (event count) desc — secondary activity frequency tiebreaker
#   k1 (workspace) asc — only matters for cross-workspace ties
#   k8 (snap_idx) asc — within-workspace tiebreaker; preserves the
#                       `workspaces.lua` declared order when stats have
#                       not yet differentiated rows.
# Then awk-strip the four aux columns so the prefetch the Go picker
# loads stays at the 7-column shape `cmd_overflow.go::loadOverflowRows`
# expects.
if [[ -s "$prefetch_aux" ]]; then
  LC_ALL=C sort -t $'\t' \
    -k6,6nr -k9,9nr -k10,10gr -k11,11nr -k1,1 -k8,8n \
    "$prefetch_aux" \
    | awk -F '\t' 'BEGIN{OFS="\t"} {print $1,$2,$3,$4,$5,$6,$7}' \
    > "$prefetch_file"
fi

if [[ ! -s "$prefetch_file" ]]; then
  tmux display-message -d 2000 \
    "Overflow picker: no configured items across any workspace"
  exit 0
fi

# shellcheck disable=SC1091
. "$script_dir/picker-bin-lib.sh"
dispatch_script="$script_dir/tab-overflow-dispatch.sh"

# Pin the picker on the file transport (popup pty has no DCS pass-through
# to the parent client tty) and inject WEZBUS_EVENT_DIR so the popup
# doesn't redo wezterm-runtime path detection from inside the popup.
picker_event_dir="$(wezterm_event_dir)"
mkdir -p "$picker_event_dir" 2>/dev/null || true

picker_binary=""
picker_rc=0
picker_binary="$(picker_bin_require "$script_dir" "Alt+t")" || picker_rc=$?
if (( picker_rc == 1 )); then
  exit 0
fi
if (( picker_rc == 2 )); then
  # WEZTERM_ALLOW_BASH_PICKER=1: legacy single-workspace tmux display-menu
  # (no fuzzy filter, no cross-workspace).
  runtime_log_warn overflow "Go picker missing — WEZTERM_ALLOW_BASH_PICKER display-menu path" \
    "trace=$trace_id"
  declare -a menu_args
  item_count=0
  accelerator_chars='123456789abcdefghijklmnopqrstuvwxyz'
  while IFS=$'\t' read -r ws label cwd state has_tab is_current sess; do
    [[ "$is_current" == "1" ]] || continue
    local_marker='○'
    case "$state" in
      visible) local_marker='●' ;;
      warm)    local_marker='◐' ;;
    esac
    if (( item_count < ${#accelerator_chars} )); then
      accel="${accelerator_chars:$item_count:1}"
    else
      accel=""
    fi
    item_count=$(( item_count + 1 ))
    esc_cwd="${cwd//\"/\\\"}"
    esc_ws="${ws//\"/\\\"}"
    esc_has_tab="${has_tab//\"/\\\"}"
    menu_args+=("$local_marker $label" "$accel" \
      "run-shell -b \"bash $dispatch_script '$esc_ws' '$esc_cwd' '$esc_has_tab'\"")
  done < "$prefetch_file"
  if (( item_count == 0 )); then
    tmux display-message -d 2000 \
      "Overflow picker: workspace '$current_workspace' has no configured items"
    exit 0
  fi
  tmux display-menu -T "All sessions · $current_workspace · $item_count" \
    -x C -y C -- "${menu_args[@]}"
  exit 0
fi

menu_done_ts=$(( ${EPOCHREALTIME//./} / 1000 ))
keypress_ts=0  # Alt+x has no upstream-stamped keypress timestamp; the
              # picker footer falls back to "key→paint" without the
              # 3-bucket lua/menu/picker breakdown.

picker_command="WEZTERM_RUNTIME_TRACE_ID=$(printf %q "$trace_id") WEZTERM_EVENT_FORCE_FILE=1 WEZBUS_EVENT_DIR=$(printf %q "$picker_event_dir") $(printf %q "$picker_binary") overflow $(printf %q "$prefetch_file") $(printf %q "$dispatch_script") $(printf %q "$keypress_ts") $(printf %q "$menu_start_ts") $(printf %q "$menu_done_ts")"

if bash "$script_dir/tmux-display-popup.sh" -x C -y C -w 80% -h 70% -T "Sessions across workspaces" -E "$picker_command"; then
  runtime_log_info overflow "popup completed" \
    "trace=$trace_id" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  exit 0
fi

runtime_log_warn overflow "popup launch failed" "trace=$trace_id"
