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
context=""
current_worktree_root=""
repo_common_dir=""
repo_label=""
main_worktree_root=""
list_root=""
start_ms="$(runtime_log_now_ms)"
trace_id="$(runtime_log_current_trace_id)"

if [[ -z "$session_name" ]]; then
  runtime_log_error worktree "worktree menu failed: missing tmux session" "current_window_id=$current_window_id" "cwd=$cwd"
  tmux display-message 'Worktree menu failed: missing tmux session'
  exit 1
fi

runtime_log_info worktree "worktree menu invoked" "session_name=$session_name" "current_window_id=$current_window_id" "cwd=$cwd"

context="$(tmux_worktree_context_for_context "$current_window_id" "$cwd" || true)"
if [[ -z "$context" ]]; then
  runtime_log_warn worktree "worktree menu could not resolve current context" "session_name=$session_name" "current_window_id=$current_window_id" "cwd=$cwd"
  tmux display-message 'Current pane is not inside a git worktree'
  exit 0
fi

IFS=$'\t' read -r current_worktree_root repo_common_dir main_worktree_root repo_label <<< "$context"
list_root="$main_worktree_root"
runtime_log_info worktree "worktree menu resolved current context" \
  "session_name=$session_name" \
  "current_window_id=$current_window_id" \
  "cwd=$cwd" \
  "current_worktree_root=$current_worktree_root" \
  "repo_common_dir=$repo_common_dir" \
  "main_worktree_root=$main_worktree_root" \
  "repo_label=$repo_label"

# Build prefetched items as both a TSV file (consumed by picker.sh's input
# loop) and parallel arrays (consumed in-process by the shared frame
# renderer below for first-frame priming).
prefetch_file="$(mktemp -t wezterm-worktree-picker.XXXXXX)"
item_labels=()
item_paths=()
item_branches=()
item_window_ids=()
item_accelerators=()
accelerators=(1 2 3 4 5 6 7 8 9 0 a b c d e f g h i j k l m n o p q r s t u v w x y z)
while IFS=$'\t' read -r worktree_label worktree_path branch_name; do
  [[ -n "$worktree_path" ]] || continue
  prefetch_window_id="$(tmux_worktree_find_window "$session_name" "$worktree_path" || true)"
  printf '%s\t%s\t%s\t%s\n' "$worktree_label" "$worktree_path" "$branch_name" "$prefetch_window_id" >> "$prefetch_file"
  item_labels+=("$worktree_label")
  item_paths+=("$worktree_path")
  item_branches+=("$branch_name")
  item_window_ids+=("$prefetch_window_id")
  if (( ${#item_labels[@]} <= ${#accelerators[@]} )); then
    item_accelerators+=("${accelerators[$((${#item_labels[@]} - 1))]}")
  else
    item_accelerators+=("")
  fi
done < <(tmux_worktree_list "$list_root" || true)
runtime_log_info worktree "worktree menu prefetched items" "session_name=$session_name" "repo_label=$repo_label" "item_count=${#item_paths[@]}" "prefetch_file=$prefetch_file"

# Pre-render the first frame to a tmp file so the popup body can `cat` it
# before bash sourcing finishes inside the popup pty. This bounds the
# perceived "no content → content" jank at "bash startup + 1 syscall"
# instead of "bash startup + 5 lib sources + array build". popup_cols /
# popup_rows mirror the `display-popup -w 70% -h 75%` geometry below
# (minus 2 cells for the popup border on each axis); a brief mismatch with
# picker.sh's stty-based render is invisible because both paint the same
# bytes for a fresh popup with no scrollback.
prefetch_frame_file="$(mktemp -t wezterm-worktree-frame.XXXXXX)"
if (( ${#item_paths[@]} > 0 )); then
  client_width="$(tmux display-message -p '#{client_width}' 2>/dev/null || echo 100)"
  client_height="$(tmux display-message -p '#{client_height}' 2>/dev/null || echo 30)"
  popup_cols=$(( client_width * 70 / 100 - 2 ))
  (( popup_cols < 20 )) && popup_cols=20
  popup_rows=$(( client_height * 75 / 100 - 2 ))
  (( popup_rows < 6 )) && popup_rows=6
  visible_rows=$(( popup_rows - 6 ))
  (( visible_rows < 1 )) && visible_rows=1

  initial_selected=0
  for idx in "${!item_paths[@]}"; do
    if [[ "${item_paths[$idx]}" == "$current_worktree_root" ]]; then
      initial_selected="$idx"
      break
    fi
  done

  # shellcheck disable=SC1091
  source "$script_dir/tmux-worktree/render.sh"
  worktree_picker_emit_frame "$popup_cols" "$visible_rows" "$initial_selected" "${#item_paths[@]}" "$current_worktree_root" "$repo_label" > "$prefetch_frame_file"
fi

picker_command="WEZTERM_RUNTIME_TRACE_ID=$(tmux_worktree_shell_quote "$trace_id") bash $(tmux_worktree_shell_quote "$script_dir/tmux-worktree-picker.sh") $(tmux_worktree_shell_quote "$session_name") $(tmux_worktree_shell_quote "$current_window_id") $(tmux_worktree_shell_quote "$list_root") $(tmux_worktree_shell_quote "$cwd") $(tmux_worktree_shell_quote "$current_worktree_root") $(tmux_worktree_shell_quote "$repo_label") $(tmux_worktree_shell_quote "$prefetch_file") $(tmux_worktree_shell_quote "$prefetch_frame_file")"

runtime_log_info worktree "opening worktree popup picker" "session_name=$session_name" "repo_label=$repo_label" "list_root=$list_root"
if tmux display-popup -x C -y C -w 70% -h 75% -T "Worktrees: $repo_label" -E "$picker_command"; then
  rm -f "$prefetch_file" "$prefetch_frame_file"
  runtime_log_info worktree "worktree popup picker completed" "session_name=$session_name" "repo_label=$repo_label" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  exit 0
fi
rm -f "$prefetch_file" "$prefetch_frame_file"

runtime_log_warn worktree "popup picker unavailable, falling back to display-menu" "session_name=$session_name" "repo_label=$repo_label"

menu_args=(display-menu -T "Worktrees: $repo_label" -x R -y P)
accelerators=(1 2 3 4 5 6 7 8 9 0 a b c d e f g h i j k l m n o p q r s t u v w x y z)
item_count=0

while IFS=$'\t' read -r worktree_label worktree_path branch_name; do
  [[ -n "$worktree_path" ]] || continue

  marker=' '
  if [[ "$worktree_path" == "$current_worktree_root" ]]; then
    marker='*'
  fi
  existing_window_id="$(tmux_worktree_find_window "$session_name" "$worktree_path" || true)"
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

  command_string="run-shell 'WEZTERM_RUNTIME_TRACE_ID=$(tmux_worktree_shell_quote "$trace_id") bash $(tmux_worktree_shell_quote "$script_dir/tmux-worktree-open.sh") $(tmux_worktree_shell_quote "$session_name") $(tmux_worktree_shell_quote "$worktree_path") $(tmux_worktree_shell_quote "$current_window_id") $(tmux_worktree_shell_quote "$cwd")'"
  menu_args+=("$menu_label" "$accelerator" "$command_string")
  ((item_count += 1))
done < <(tmux_worktree_list "$list_root" || true)

if (( item_count == 0 )); then
  tmux display-message "No git worktrees found for $repo_label"
  exit 0
fi

runtime_log_info worktree "opening worktree menu fallback" "session_name=$session_name" "repo_label=$repo_label" "item_count=$item_count"
runtime_log_info worktree "worktree menu fallback opened" "session_name=$session_name" "repo_label=$repo_label" "item_count=$item_count" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
tmux "${menu_args[@]}"
