#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-worktree-lib.sh"

session_name="${1:-}"
current_window_id="${2:-}"
cwd="${3:-$PWD}"

if [[ -z "$session_name" ]]; then
  tmux display-message 'Worktree cycle failed: missing tmux session'
  exit 1
fi

repo_common_dir="$(tmux_worktree_session_option "$session_name" @wezterm_repo_common_dir)"
main_worktree_root="$(tmux_worktree_session_option "$session_name" @wezterm_main_worktree_root)"
if [[ -z "$repo_common_dir" ]]; then
  tmux display-message 'Current session is not a git worktree session'
  exit 0
fi

current_worktree_root=""
if [[ -n "$current_window_id" ]]; then
  current_worktree_root="$(tmux_worktree_window_option "$current_window_id" @wezterm_worktree_root)"
fi
if [[ -z "$current_worktree_root" && -d "$cwd" ]] && tmux_worktree_in_git_repo "$cwd"; then
  current_worktree_root="$(tmux_worktree_repo_root "$cwd")"
fi

list_root="$cwd"
if [[ -n "$main_worktree_root" ]]; then
  list_root="$main_worktree_root"
fi

mapfile -t worktree_paths < <(tmux_worktree_list "$list_root" | awk -F '\t' '{print $2}')

if (( ${#worktree_paths[@]} == 0 )); then
  tmux display-message 'No git worktrees available in the current repo'
  exit 0
fi

target_index=0
for index in "${!worktree_paths[@]}"; do
  if [[ "${worktree_paths[$index]}" == "$current_worktree_root" ]]; then
    target_index=$(((index + 1) % ${#worktree_paths[@]}))
    break
  fi
done

next_worktree_root="${worktree_paths[$target_index]}"
runtime_log_info worktree "cycling worktree window" "session_name=$session_name" "current_worktree_root=$current_worktree_root" "next_worktree_root=$next_worktree_root"
bash "$script_dir/tmux-worktree-open.sh" "$session_name" "$next_worktree_root"
