#!/usr/bin/env bash
# Tab-visibility overflow picker. Bound to user-key User4 (Alt+t).
#
# Reads the per-workspace items snapshot written by workspace_manager
# at workspace open (<state>/tab-stats/<slug>-items.json), computes the
# unspawned subset (configured items whose tmux session does not yet
# exist), and pops a tmux display-menu listing them. On Enter, dispatches
# a `tab.spawn_overflow` event back to wezterm with workspace+cwd; the
# wezterm-side handler calls Workspace.spawn_or_activate to materialize
# the tab in the current workspace window.
#
# When everything in the workspace is already spawned (or the snapshot
# is missing because the user hasn't opened the workspace yet under the
# new lua), shows a toast instead of an empty menu.
#
# Schema + algorithm: docs/tab-visibility.md.

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/tab-stats-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/tmux-worktree-lib.sh" 2>/dev/null || {
  # Fallback: warm marker can't be computed; everything will be tagged
  # cold/visible based purely on has_tab. Acceptable degradation.
  tmux_worktree_session_name_for_path() { :; }
}

session_name="${1:-}"
client_tty="${2:-}"

if [[ -z "$session_name" ]]; then
  session_name="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"
fi

workspace="$(tmux show-options -v -t "$session_name" @wezterm_workspace 2>/dev/null || true)"
if [[ -z "$workspace" ]]; then
  workspace="default"
fi

slug="$(tab_stats_workspace_slug "$workspace")"
snapshot="$(tab_stats_dir)/${slug}-items.json"

if [[ ! -f "$snapshot" ]]; then
  tmux display-message -d 3000 \
    "Overflow picker: no items snapshot for workspace '$workspace' yet (open the workspace first)"
  exit 0
fi

# Build menu argv: each item contributes three tmux-display-menu args
#   "<label>" "<accelerator>" "<dispatch command>"
#
# Lists ALL configured items, marked by current visibility state:
#   ●  visible  (already a wezterm tab in this workspace)
#   ◐  warm     (tmux session exists, projects into overflow tab)
#   ○  cold     (no tmux session yet, spawn fallback)
#
# Dispatch goes through tab-overflow-dispatch.sh which routes per the
# state. Visible picks activate the existing tab; warm picks switch the
# overflow pane to that session; cold picks fall back to the managed-
# spawn path.
declare -a menu_args
item_count=0
accelerator_chars='123456789abcdefghijklmnopqrstuvwxyz'

# Snapshot tmux sessions once so each item can compute warm/cold cheaply.
existing_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"

while IFS=$'\t' read -r cwd label has_tab; do
  [[ -n "$cwd" ]] || continue
  marker='○'
  if [[ "$has_tab" == "true" ]]; then
    marker='●'
  else
    candidate_session="$(tmux_worktree_session_name_for_path "$workspace" "$cwd" 2>/dev/null || true)"
    if [[ -n "$candidate_session" ]] \
      && grep -Fxq "$candidate_session" <<<"$existing_sessions" 2>/dev/null; then
      marker='◐'
    fi
  fi
  if (( item_count < ${#accelerator_chars} )); then
    accel="${accelerator_chars:$item_count:1}"
  else
    accel=""
  fi
  item_count=$(( item_count + 1 ))
  esc_cwd="${cwd//\"/\\\"}"
  esc_ws="${workspace//\"/\\\"}"
  menu_args+=("$marker $label" "$accel" "run-shell -b \"bash $script_dir/tab-overflow-dispatch.sh '$esc_ws' '$esc_cwd' '$has_tab'\"")
done < <(jq -r '.items[] | [.cwd, .label, (.has_tab // false | tostring)] | @tsv' "$snapshot" 2>/dev/null)

if (( item_count == 0 )); then
  tmux display-message -d 2000 \
    "Overflow picker: workspace '$workspace' has no configured items"
  exit 0
fi

# tmux display-menu opens centered, modal, anchored to the current client.
tmux display-menu -T "All sessions · $workspace · $item_count" \
  -x C -y C -- "${menu_args[@]}"
