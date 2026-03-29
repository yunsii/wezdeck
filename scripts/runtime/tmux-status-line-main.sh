#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

cwd="${1:-$PWD}"
padding="${TMUX_STATUS_PADDING:- }"
separator="${TMUX_STATUS_SEPARATOR:- · }"
render_repo="${TMUX_STATUS_RENDER_REPO:-1}"
render_branch="${TMUX_STATUS_RENDER_BRANCH:-1}"
render_git_changes="${TMUX_STATUS_RENDER_GIT_CHANGES:-1}"
render_node="${TMUX_STATUS_RENDER_NODE:-1}"
parts=()

if is_enabled "$render_repo"; then
  repo_part="$(bash "$script_dir/tmux-status-repo.sh" "$cwd")"
  [[ -n "$repo_part" ]] && parts+=("$repo_part")
fi

if is_enabled "$render_branch"; then
  branch_part="$(bash "$script_dir/tmux-status-branch.sh" "$cwd")"
  [[ -n "$branch_part" ]] && parts+=("$branch_part")
fi

if is_enabled "$render_git_changes"; then
  git_changes_part="$(bash "$script_dir/tmux-status-git-changes.sh" "$cwd")"
  [[ -n "$git_changes_part" ]] && parts+=("$git_changes_part")
fi

if is_enabled "$render_node"; then
  node_part="$(bash "$script_dir/tmux-status-node.sh")"
  [[ -n "$node_part" ]] && parts+=("$node_part")
fi

if (( ${#parts[@]} == 0 )); then
  exit 0
fi

printf '%s' "$padding"
join_with_separator "$(style 'fg=#7f7a72' "$separator")" "${parts[@]}"
