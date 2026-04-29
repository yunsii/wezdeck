#!/usr/bin/env bash
# Cross-workspace tab-overflow picker. Bound to user-key User4 (Alt+x).
#
# Enumerates `<state>/tab-stats/*-items.json` (one snapshot per workspace
# that has been opened under tab_visibility), tags each item with its
# current state (visible / warm / cold) computed from live tmux sessions,
# and pops a popup picker listing every row across every workspace. The
# active workspace's rows rank first (preserving snapshot order) so the
# in-workspace flow is unchanged; rows from other workspaces sit below
# and become reachable via the always-on substring filter.
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

# Build per-workspace TSV blocks then concatenate in priority order
# (current workspace first, then alphabetical). Within each block the
# snapshot's natural item order is preserved.
prefetch_file="$(mktemp -t wezterm-overflow-picker.XXXXXX)"
trap 'rm -f "$prefetch_file"' EXIT

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

# Sort the other-workspace block alphabetically so the row order is
# deterministic across runs (snapshot file order is filesystem-dependent).
if (( ${#other_workspaces[@]} > 0 )); then
  IFS=$'\n' read -r -d '' -a other_workspaces < <(
    printf '%s\n' "${other_workspaces[@]}" | LC_ALL=C sort -u
    printf '\0'
  )
fi

emit_workspace_rows() {
  local target_ws="$1"
  local target_snapshot="$stats_dir/$(tab_stats_workspace_slug "$target_ws")-items.json"
  [[ -f "$target_snapshot" ]] || return 0
  local is_current=0
  [[ "$target_ws" == "$current_workspace" ]] && is_current=1
  while IFS=$'\t' read -r cwd label has_tab; do
    [[ -n "$cwd" ]] || continue
    local state='cold'
    local sess=''
    if [[ "$has_tab" == "true" ]]; then
      state='visible'
    else
      sess="$(tmux_worktree_session_name_for_path "$target_ws" "$cwd" 2>/dev/null || true)"
      if [[ -n "$sess" ]] && grep -Fxq "$sess" <<<"$existing_sessions" 2>/dev/null; then
        state='warm'
      fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$target_ws" "$label" "$cwd" "$state" "$has_tab" "$is_current" "$sess" \
      >> "$prefetch_file"
  done < <(jq -r '.items[] | [.cwd, .label, (.has_tab // false | tostring)] | @tsv' "$target_snapshot" 2>/dev/null)
}

emit_workspace_rows "$current_workspace"
for ws in "${other_workspaces[@]}"; do
  emit_workspace_rows "$ws"
done

if [[ ! -s "$prefetch_file" ]]; then
  tmux display-message -d 2000 \
    "Overflow picker: no configured items across any workspace"
  exit 0
fi

repo_root="$(cd "$script_dir/../.." && pwd)"
picker_binary="$repo_root/native/picker/bin/picker"
dispatch_script="$script_dir/tab-overflow-dispatch.sh"

# Pin the picker on the file transport (popup pty has no DCS pass-through
# to the parent client tty) and inject WEZBUS_EVENT_DIR so the popup
# doesn't redo wezterm-runtime path detection from inside the popup.
picker_event_dir="$(wezterm_event_dir)"
mkdir -p "$picker_event_dir" 2>/dev/null || true

if [[ ! -x "$picker_binary" ]]; then
  # Hard fallback: the legacy single-workspace tmux display-menu. Lists
  # only the active workspace's items and uses tmux-native accelerators
  # (no fuzzy filter, no cross-workspace). Logs so we know when a host is
  # missing the Go binary.
  runtime_log_warn overflow "Go picker missing — falling back to display-menu" \
    "trace=$trace_id" "binary=$picker_binary"
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

if tmux display-popup -x C -y C -w 80% -h 70% -T "Sessions across workspaces" -E "$picker_command"; then
  runtime_log_info overflow "popup completed" \
    "trace=$trace_id" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  exit 0
fi

runtime_log_warn overflow "popup launch failed" "trace=$trace_id"
