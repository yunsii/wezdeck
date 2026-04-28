#!/usr/bin/env bash
# Unified dispatch for an Alt+t picker selection. Three cases:
#
#   1. Selected item is already a visible wezterm tab (has_tab=true)
#      → emit `tab.activate_visible cwd=<cwd> workspace=<ws>` so the
#        wezterm side activates that existing tab.
#
#   2. Selected item is a configured-but-non-visible session whose tmux
#      session exists (warm)
#      → run tab-overflow-attach.sh to switch-client the overflow pane
#        to that session, then emit `tab.activate_overflow workspace=<ws>`
#        so wezterm jumps to the overflow tab.
#
#   3. Selected item is cold (no tmux session yet)
#      → fall back to the existing `tab.spawn_overflow` event so the
#        wezterm side spawns it as a new wezterm tab via the managed-
#        spawn path. Cold session creation needs the lua-side launch
#        command from constants.managed_cli; it cannot land in overflow
#        until we plumb that into bash.
#
# Usage: tab-overflow-dispatch.sh <workspace> <cwd> <has_tab>
set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/wezterm-event-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/tmux-worktree-lib.sh" 2>/dev/null || {
  tmux_worktree_session_name_for_path() { :; }
}

workspace="${1:?missing workspace}"
cwd="${2:?missing cwd}"
has_tab="${3:-false}"

if [[ "$has_tab" == "true" ]]; then
  WEZTERM_EVENT_FORCE_FILE=1 \
    wezterm_event_send "tab.activate_visible" \
      "v1|workspace=${workspace}|cwd=${cwd}" || true
  exit 0
fi

# Non-visible: figure out the candidate tmux session name for this cwd
# under this workspace, then check if it already exists in tmux.
candidate_session="$(tmux_worktree_session_name_for_path "$workspace" "$cwd" 2>/dev/null || true)"

if [[ -n "$candidate_session" ]] && tmux has-session -t "$candidate_session" 2>/dev/null; then
  # Warm: switch the overflow pane to it, then jump to the overflow tab.
  # session= in the payload refreshes the wezterm-side overflow→session
  # map (consumed by attention auto-ack + Alt+/ jump fallback when an
  # entry's stored wezterm_pane_id no longer exists). The tab title
  # intentionally stays `…` regardless.
  if bash "$script_dir/tab-overflow-attach.sh" "$workspace" "$candidate_session" 2>&1; then
    WEZTERM_EVENT_FORCE_FILE=1 \
      wezterm_event_send "tab.activate_overflow" \
        "v1|workspace=${workspace}|session=${candidate_session}" || true
    exit 0
  fi
  # switch-client failed — fall through to spawn fallback as a safety net.
  printf '[tab-overflow-dispatch] switch-client failed for %s, falling back to spawn\n' \
    "$candidate_session" >&2
fi

# Cold: create a bare tmux session, project to overflow, jump to it.
# No new wezterm tab. The session is bare bash (not the managed agent
# — see tab-overflow-cold-spawn.sh limitation note); user can run
# `claude --continue` themselves.
bash "$script_dir/tab-overflow-cold-spawn.sh" "$workspace" "$cwd"
