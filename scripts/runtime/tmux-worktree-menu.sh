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
  tmux display-message 'Worktree menu failed: missing tmux session'
  exit 1
fi

repo_common_dir="$(tmux_worktree_session_option "$session_name" @wezterm_repo_common_dir)"
repo_label="$(tmux_worktree_session_option "$session_name" @wezterm_repo_label)"
main_worktree_root="$(tmux_worktree_session_option "$session_name" @wezterm_main_worktree_root)"

if [[ -z "$repo_common_dir" ]]; then
  tmux display-message 'Current session is not a git worktree session'
  exit 0
fi

if [[ -z "$repo_label" ]]; then
  repo_label='repo'
fi

list_root="$cwd"
if [[ -n "$main_worktree_root" ]]; then
  list_root="$main_worktree_root"
fi

menu_args=(display-menu -T "Worktrees: $repo_label" -x R -y P)
accelerators=(1 2 3 4 5 6 7 8 9 0 a b c d e f g h i j k l m n o p q r s t u v w x y z)
item_count=0

while IFS=$'\t' read -r worktree_label worktree_path branch_name; do
  [[ -n "$worktree_path" ]] || continue

  marker=' '
  existing_window_id="$(tmux_worktree_find_window "$session_name" "$worktree_path" || true)"
  if [[ -n "$current_window_id" && "$existing_window_id" == "$current_window_id" ]]; then
    marker='*'
  fi
  menu_label="$marker $worktree_label"
  if [[ -n "$branch_name" ]]; then
    menu_label="$menu_label [$branch_name]"
  fi
  if [[ -z "$existing_window_id" ]]; then
    menu_label="$menu_label (new)"
  fi

  accelerator=''
  if (( item_count < ${#accelerators[@]} )); then
    accelerator="${accelerators[$item_count]}"
  fi

  command_string="run-shell 'bash $(tmux_worktree_shell_quote "$script_dir/tmux-worktree-open.sh") $(tmux_worktree_shell_quote "$session_name") $(tmux_worktree_shell_quote "$worktree_path")'"
  menu_args+=("$menu_label" "$accelerator" "$command_string")
  ((item_count += 1))
done < <(tmux_worktree_list "$list_root" || true)

if (( item_count == 0 )); then
  tmux display-message "No git worktrees found for $repo_label"
  exit 0
fi

runtime_log_info worktree "opening worktree menu" "session_name=$session_name" "repo_label=$repo_label" "item_count=$item_count"
tmux "${menu_args[@]}"
