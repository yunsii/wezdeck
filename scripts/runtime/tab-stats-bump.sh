#!/usr/bin/env bash
# Bump session focus stats. Called from the tmux `session-changed` hook
# (and any other producer that knows a session just took focus).
#
# Usage: tab-stats-bump.sh <session_name> [<workspace>]
#
# Workspace defaults to the @wezterm_workspace tmux session-option when
# the caller does not pass it explicitly. If neither source resolves we
# log to stderr and return 0 (must not break the tmux hook chain).

set -u

__TAB_STATS_BUMP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$__TAB_STATS_BUMP_DIR/tab-stats-lib.sh"

session_name="${1:-}"
workspace="${2:-}"

if [[ -z "$session_name" ]]; then
  printf '[tab-stats-bump] missing session_name\n' >&2
  exit 0
fi

if [[ -z "$workspace" ]]; then
  workspace="$(tmux show-options -v -t "$session_name" @wezterm_workspace 2>/dev/null || true)"
fi

if [[ -z "$workspace" ]]; then
  workspace="${WEZTERM_WORKSPACE:-}"
fi

if [[ -z "$workspace" ]]; then
  # Untagged session — common for the `default` workspace shells that
  # never went through open-project-session. Bucket them under a stable
  # slug so the data is at least observable.
  workspace="default"
fi

tab_stats_bump "$workspace" "$session_name" || true
