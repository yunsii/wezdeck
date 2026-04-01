#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-worktree-lib.sh"

session_name="${1:-}"
worktree_root="${2:-}"
source_window_id="${3:-}"
cwd="${4:-$PWD}"
target_common_dir=""
context=""
source_worktree_root=""
main_worktree_root=""
worktree_label=""
window_id=""
template_window=""

if [[ -z "$session_name" || -z "$worktree_root" ]]; then
  runtime_log_error worktree "worktree switch failed: missing session or worktree path" "session_name=$session_name" "worktree_root=$worktree_root" "source_window_id=$source_window_id" "cwd=$cwd"
  tmux display-message 'Worktree switch failed: missing session or worktree path'
  exit 1
fi

runtime_log_info worktree "worktree switch invoked" "session_name=$session_name" "worktree_root=$worktree_root" "source_window_id=$source_window_id" "cwd=$cwd"

worktree_root="$(tmux_worktree_abs_path "$worktree_root")"

if ! tmux has-session -t "$session_name" 2>/dev/null; then
  runtime_log_error worktree "worktree switch failed: missing tmux session" "session_name=$session_name" "worktree_root=$worktree_root" "source_window_id=$source_window_id" "cwd=$cwd"
  tmux display-message "Worktree switch failed: missing session $session_name"
  exit 1
fi

if [[ ! -d "$worktree_root" ]]; then
  runtime_log_error worktree "worktree path is unavailable" "session_name=$session_name" "worktree_root=$worktree_root"
  tmux display-message "Worktree path is unavailable: $worktree_root"
  exit 1
fi

if ! tmux_worktree_in_git_repo "$worktree_root"; then
  runtime_log_error worktree "target path is not a git worktree" "session_name=$session_name" "worktree_root=$worktree_root"
  tmux display-message "Not a git worktree: $worktree_root"
  exit 1
fi

target_common_dir="$(tmux_worktree_common_dir "$worktree_root" || true)"
if [[ -z "$target_common_dir" ]]; then
  runtime_log_warn worktree "target worktree common dir was unavailable" "session_name=$session_name" "worktree_root=$worktree_root"
  tmux display-message "Target path is not a git worktree: $worktree_root"
  exit 0
fi

context="$(tmux_worktree_context_for_context "$source_window_id" "$cwd" || true)"
if [[ -z "$context" ]]; then
  runtime_log_warn worktree "current context could not be resolved during worktree switch" "session_name=$session_name" "worktree_root=$worktree_root" "source_window_id=$source_window_id" "cwd=$cwd"
  tmux display-message 'Current pane is not inside a git worktree'
  exit 0
fi

IFS=$'\t' read -r source_worktree_root repo_common_dir _ _ <<< "$context"
runtime_log_info worktree "worktree switch resolved current context" \
  "session_name=$session_name" \
  "source_window_id=$source_window_id" \
  "cwd=$cwd" \
  "source_worktree_root=$source_worktree_root" \
  "repo_common_dir=$repo_common_dir" \
  "target_common_dir=$target_common_dir" \
  "target_worktree_root=$worktree_root"
if [[ "$target_common_dir" != "$repo_common_dir" ]]; then
  runtime_log_warn worktree "target worktree does not match current repo family" \
    "session_name=$session_name" \
    "source_window_id=$source_window_id" \
    "source_worktree_root=$source_worktree_root" \
    "repo_common_dir=$repo_common_dir" \
    "target_common_dir=$target_common_dir" \
    "target_worktree_root=$worktree_root"
  tmux display-message 'Target path is not part of the current repo family'
  exit 1
fi

main_worktree_root="$(tmux_worktree_main_root "$repo_common_dir" || true)"
worktree_label="$(tmux_worktree_label_for_root "$worktree_root" "$main_worktree_root")"
window_id="$(tmux_worktree_find_window "$session_name" "$worktree_root" || true)"

if [[ -z "$window_id" ]]; then
  runtime_log_info worktree "creating worktree window" "session_name=$session_name" "worktree_root=$worktree_root" "worktree_label=$worktree_label"
  template_window="$(tmux_worktree_template_window "$session_name" "$source_window_id" || true)"
  runtime_log_info worktree "using template window for worktree creation" "session_name=$session_name" "template_window=${template_window:-none}" "source_window_id=$source_window_id" "source_worktree_root=$source_worktree_root"
  window_id="$(tmux_worktree_create_window_from_template "$session_name" "$worktree_root" "$worktree_label" "$template_window" "$source_worktree_root")"
else
  runtime_log_info worktree "selecting existing worktree window" "session_name=$session_name" "window_id=$window_id" "worktree_root=$worktree_root" "worktree_label=$worktree_label"
  tmux rename-window -t "$window_id" "$worktree_label"
fi

tmux select-window -t "$window_id"
selection_metadata="$(tmux display-message -p -t "$window_id" '#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_path}' 2>/dev/null || true)"
runtime_log_info worktree "selected tmux worktree window" "session_name=$session_name" "window_id=$window_id" "worktree_root=$worktree_root" "selection_metadata=${selection_metadata:-unavailable}"
bash "$script_dir/tmux-status-refresh.sh" \
  --session "$session_name" \
  --window "$window_id" \
  --cwd "$worktree_root" \
  --force \
  --no-debounce \
  --refresh-client >/dev/null 2>&1 || true
