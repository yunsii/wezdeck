#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-worktree-lib.sh"

session_name="${1:-}"
window_id="${2:-}"
cwd="${3:-$PWD}"

if [[ ! -d "$cwd" ]]; then
  cwd="$PWD"
fi

main_worktree_root=""
worktree_label=""
list_root="$cwd"
linked_count=""

if [[ -n "$session_name" ]]; then
  main_worktree_root="$(tmux_worktree_session_option "$session_name" @wezterm_main_worktree_root)"
fi

if [[ -n "$window_id" ]]; then
  worktree_label="$(tmux_worktree_window_option "$window_id" @wezterm_worktree_label)"
fi

if [[ -z "$worktree_label" ]] && tmux_worktree_in_git_repo "$cwd"; then
  worktree_root="$(tmux_worktree_repo_root "$cwd")"
  if [[ -z "$main_worktree_root" ]]; then
    main_worktree_root="$(tmux_worktree_main_root "$(tmux_worktree_common_dir "$cwd")" || true)"
  fi
  worktree_label="$(tmux_worktree_label_for_root "$worktree_root" "$main_worktree_root")"
fi

if [[ -n "$main_worktree_root" ]]; then
  list_root="$main_worktree_root"
fi

if [[ -n "$worktree_label" ]]; then
  linked_count="$(tmux_worktree_linked_count "$list_root")"
  join_with_separator \
    "$(style 'fg=#7f7a72' ' · ')" \
    "$(style 'fg=#7f7a72' "linked:${linked_count:-0}")" \
    "$(style 'fg=#4e7a54' "$worktree_label")"
else
  style 'fg=#7f7a72' 'no-worktree'
fi
