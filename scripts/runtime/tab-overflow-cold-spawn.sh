#!/usr/bin/env bash
# Cold-session bring-up for the overflow tab. Called when the Alt+t
# picker selects an `○` cold item (configured in workspaces.lua but
# without a live tmux session). Creates a bare tmux session for the
# given cwd, then switch-clients the overflow pane to it.
#
# Usage: tab-overflow-cold-spawn.sh <workspace> <cwd>
#
# Limitation: the resulting session is a plain bash shell, not the
# managed agent (claude / codex). Starting the agent from bash needs
# to know the active managed_cli profile + its command, which is
# composed lua-side and not available here. PR4 will plumb that
# through. For now the user can `claude --continue` themselves once
# they're in the projected session — better than the previous
# behavior of silently spawning a new wezterm tab.
set -u

workspace="${1:?missing workspace}"
cwd="${2:?missing cwd}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/wezterm-event-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/tmux-worktree-lib.sh" 2>/dev/null || {
  printf '[tab-overflow-cold-spawn] tmux-worktree-lib unavailable\n' >&2
  exit 1
}

session_name="$(tmux_worktree_session_name_for_path "$workspace" "$cwd" 2>/dev/null || true)"
if [[ -z "$session_name" ]]; then
  printf '[tab-overflow-cold-spawn] could not compute session name for %s\n' "$cwd" >&2
  exit 1
fi

# Idempotent: -A attaches if the session already exists. -d stays
# detached. Bare bash session if not already there.
if ! tmux new-session -A -d -s "$session_name" -c "$cwd" 2>/dev/null; then
  printf '[tab-overflow-cold-spawn] tmux new-session failed for %s\n' "$session_name" >&2
  exit 2
fi

# Tag the new session with the workspace so any future per-workspace
# tooling (focus stats hook etc.) buckets it correctly.
tmux set-option -t "$session_name" -q @wezterm_workspace "$workspace" 2>/dev/null || true

if ! bash "$script_dir/tab-overflow-attach.sh" "$workspace" "$session_name"; then
  printf '[tab-overflow-cold-spawn] tab-overflow-attach.sh failed\n' >&2
  exit 3
fi

WEZTERM_EVENT_FORCE_FILE=1 \
  wezterm_event_send "tab.activate_overflow" "v1|workspace=${workspace}" || true
