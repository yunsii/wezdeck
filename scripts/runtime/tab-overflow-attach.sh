#!/usr/bin/env bash
# Switch the tab-visibility overflow tab pane (in workspace <workspace>)
# to attach a different tmux session via `tmux switch-client -c <tty>`.
#
# The overflow tab pane runs a tmux client attached to either the
# per-workspace browse session (Browse state) or some target session
# (Attached state). Its tty path is recorded by spawn_overflow_tab into
# /tmp/wezterm-overflow-<workspace_slug>-tty.txt at pane spawn; this
# script reads that path and dispatches a switch-client targeting it.
#
# Usage: tab-overflow-attach.sh <workspace> <target_session>
#
# Returns:
#   0 on success
#   1 missing args / no tty file / empty tty
#   2 target session does not exist (cold; caller should create first)
#   3 switch-client failed
set -u

workspace="${1:?missing workspace}"
target="${2:?missing target_session}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/tab-stats-lib.sh"

slug="$(tab_stats_workspace_slug "$workspace")"
state_file="/tmp/wezterm-overflow-${slug}-tty.txt"

if [[ ! -f "$state_file" ]]; then
  printf '[tab-overflow-attach] no tty state for workspace %q (overflow tab not opened?)\n' \
    "$workspace" >&2
  exit 1
fi

tty_path="$(< "$state_file")"
if [[ -z "$tty_path" ]]; then
  printf '[tab-overflow-attach] empty tty in %s\n' "$state_file" >&2
  exit 1
fi

if ! tmux has-session -t "$target" 2>/dev/null; then
  printf '[tab-overflow-attach] target session %q does not exist\n' "$target" >&2
  exit 2
fi

# switch-client targeting the overflow client by tty. tmux is happy
# with the tty path as the client identifier.
if ! tmux switch-client -c "$tty_path" -t "$target" 2>/dev/null; then
  printf '[tab-overflow-attach] switch-client failed (tty=%s, target=%s)\n' \
    "$tty_path" "$target" >&2
  exit 3
fi
