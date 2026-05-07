#!/usr/bin/env bash
# Bulk-compute the canonical tmux session name for each cwd in a
# workspace, so the lua side can join `workspaces.lua` items against
# `tab_visibility` ranking without forking once per item. Output is
# `<cwd>\t<session_name>` per line, in input order. Empty session_name
# is emitted on a per-cwd error so the lua caller still gets a row per
# input.
#
# Usage:
#   print-session-names.sh <workspace> <cwd1> [<cwd2> ...]
#
# Reads from `tmux-worktree-lib.sh` so the session-name shape stays in
# lockstep with everything else that mints session names
# (`open-project-session.sh`, `tab-overflow-cold-spawn.sh`,
# `resolve-vscode-target.sh`, etc.). Editing the formula in one place
# updates the join everywhere.
set -u

if (( $# < 2 )); then
  echo "usage: $0 <workspace> <cwd1> [<cwd2> ...]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/../tmux-worktree-lib.sh"

workspace="$1"
shift

for cwd in "$@"; do
  sess="$(tmux_worktree_session_name_for_path "$workspace" "$cwd" 2>/dev/null || true)"
  printf '%s\t%s\n' "$cwd" "$sess"
done
