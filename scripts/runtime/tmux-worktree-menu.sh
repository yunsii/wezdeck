#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/runtime-env-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/menu-bench-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-worktree-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/attention-state-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-user-interact-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/access-ledger-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/worktree/lib/prefetch-list.sh"

# Machine preference: popup (default/recommended) | sidebar (parked experiment).
# See local.example/shared.env and docs/tmux-ui.md.
runtime_env_load_managed 2>/dev/null || true
picker_ui="$(printf '%s' "${WEZTERM_WORKTREE_PICKER_UI:-popup}" | tr '[:upper:]' '[:lower:]')"
case "$picker_ui" in
  sidebar|float|floating) picker_ui=sidebar ;;
  *) picker_ui=popup ;;
esac

# Microbench short-circuit for scripts/dev/bench-menu-prep.sh --target worktree.
menu_bench_init
bench_mark sourced

session_name="${1:-}"
current_window_id="${2:-}"
cwd="${3:-$PWD}"
current_worktree_root=""
repo_common_dir=""
repo_label=""
main_worktree_root=""
list_root=""
context_origin=""
item_labels=()
item_paths=()
item_branches=()
item_window_ids=()
item_accelerators=()
start_ms="$(runtime_log_now_ms)"
trace_id="$(runtime_log_current_trace_id)"

if [[ -z "$session_name" ]]; then
  runtime_log_error worktree "worktree menu failed: missing tmux session" "current_window_id=$current_window_id" "cwd=$cwd"
  tmux display-message 'Worktree menu failed: missing tmux session'
  exit 1
fi

runtime_log_info worktree "worktree menu invoked" \
  "session_name=$session_name" \
  "current_window_id=$current_window_id" \
  "cwd=$cwd" \
  "picker_ui=$picker_ui"

# Sidebar pilot: same Alt+g, toggle floating list. Popup path unchanged.
if [[ "$picker_ui" == sidebar ]]; then
  if menu_bench_active; then
    menu_bench_dump_and_exit "picker_kind=sidebar" "item_count=0"
  fi
  exec bash "$script_dir/worktree-sidebar.sh" toggle \
    "$session_name" "$current_window_id" "$cwd"
fi

# Prefetch TSV + arrays (worktree/lib/prefetch-list.sh). Popup path below.
prefetch_file="$(mktemp -t wezterm-worktree-picker.XXXXXX)"
WORKTREE_PREFETCH_START_MS="$start_ms"
prefetch_rc=0
worktree_prefetch_list "$session_name" "$current_window_id" "$cwd" "$prefetch_file" || prefetch_rc=$?
unset WORKTREE_PREFETCH_START_MS
if (( prefetch_rc == 2 )); then
  rm -f "$prefetch_file"
  runtime_log_warn worktree "worktree menu could not resolve current context" "session_name=$session_name" "current_window_id=$current_window_id" "cwd=$cwd"
  tmux display-message 'No git worktree in this session (pane cwd may be deleted)'
  exit 0
fi
if (( prefetch_rc != 0 )); then
  rm -f "$prefetch_file"
  runtime_log_error worktree "worktree menu prefetch failed" "session_name=$session_name" "prefetch_rc=$prefetch_rc"
  tmux display-message 'Worktree menu failed: prefetch error'
  exit 1
fi

runtime_log_info worktree "worktree menu resolved current context" \
  "session_name=$session_name" \
  "current_window_id=$current_window_id" \
  "cwd=$cwd" \
  "context_origin=$context_origin" \
  "current_worktree_root=$current_worktree_root" \
  "repo_common_dir=$repo_common_dir" \
  "main_worktree_root=$main_worktree_root" \
  "repo_label=$repo_label"
runtime_log_info worktree "worktree menu prefetched items" "session_name=$session_name" "repo_label=$repo_label" "item_count=${#item_paths[@]}" "prefetch_file=$prefetch_file"

# Pre-render the first frame to a tmp file so the popup body can `cat` it
# before bash sourcing finishes inside the popup pty. This bounds the
# perceived "no content → content" jank at "bash startup + 1 syscall"
# instead of "bash startup + 5 lib sources + array build". popup_cols /
# popup_rows mirror the `display-popup -w 70% -h 75%` geometry below
# (minus 2 cells for the popup border on each axis); a brief mismatch with
# picker.sh's stty-based render is invisible because both paint the same
# bytes for a fresh popup with no scrollback.
# Go-only picker (cold start ~2-5ms; owns first paint). Bash path is
# emergency-only via WEZTERM_ALLOW_BASH_PICKER=1.
# shellcheck disable=SC1091
. "$script_dir/picker-bin-lib.sh"
prefetch_frame_file=''
picker_kind='go'
open_script="$script_dir/tmux-worktree-open.sh"
picker_binary=""
picker_rc=0
picker_binary="$(picker_bin_require "$script_dir" "Alt+g")" || picker_rc=$?
if (( picker_rc == 1 )); then
  rm -f "$prefetch_file"
  exit 0
fi

if (( picker_rc == 0 )); then
  picker_kind='go'
  # EPOCHREALTIME (µs/1000 → ms) avoids the ~5ms `date` fork on the popup
  # hot path; matches the inlined idiom in tmux-attention-menu.sh.
  menu_done_ts=$(( ${EPOCHREALTIME//./} / 1000 ))
  picker_command=$(printf 'WEZTERM_RUNTIME_TRACE_ID=%q %q worktree %q %q %q %q %q %q %q %q %q %q' \
    "$trace_id" "$picker_binary" \
    "$prefetch_file" "$open_script" \
    "$session_name" "$current_window_id" "$cwd" \
    "$current_worktree_root" "$repo_label" \
    "$start_ms" "$start_ms" "$menu_done_ts")
else
  # WEZTERM_ALLOW_BASH_PICKER=1 emergency path.
  picker_kind='bash'
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
fi
bench_mark frame_rendered
bench_mark prep_done

if menu_bench_active; then
  rm -f "$prefetch_file" "$prefetch_frame_file"
  menu_bench_dump_and_exit "picker_kind=$picker_kind" "item_count=${#item_paths[@]}"
fi

runtime_log_info worktree "opening worktree popup picker" "session_name=$session_name" "repo_label=$repo_label" "list_root=$list_root"
if bash "$script_dir/tmux-display-popup.sh" -x C -y C -w 70% -h 75% -T "Worktrees: $repo_label" -E "$picker_command"; then
  rm -f "$prefetch_file" "$prefetch_frame_file"
  runtime_log_info worktree "worktree popup picker completed" "session_name=$session_name" "repo_label=$repo_label" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  exit 0
fi
rm -f "$prefetch_file" "$prefetch_frame_file"

runtime_log_warn worktree "popup picker unavailable, falling back to display-menu" "session_name=$session_name" "repo_label=$repo_label"

menu_args=(display-menu -T "Worktrees: $repo_label" -x R -y P)
item_count=0

# Reuse the already-ranked arrays instead of re-walking git: they carry
# the same user-interact-first order as the popup and their window ids are
# already resolved, so this path no longer forks `tmux_worktree_find_window`
# once per worktree.
for index in "${!item_paths[@]}"; do
  worktree_label="${item_labels[$index]}"
  worktree_path="${item_paths[$index]}"
  branch_name="${item_branches[$index]}"

  marker=' '
  if [[ "$worktree_path" == "$current_worktree_root" ]]; then
    marker='*'
  fi
  menu_label="$marker $worktree_label"
  if [[ -n "$branch_name" ]]; then
    menu_label="$menu_label [$branch_name]"
  fi
  # No "(new)" suffix: window presence does not matter for selection
  # (create+resume on demand). The Go picker shows last-visit age instead.

  accelerator="${item_accelerators[$index]}"

  command_string="run-shell 'WEZTERM_RUNTIME_TRACE_ID=$(tmux_worktree_shell_quote "$trace_id") bash $(tmux_worktree_shell_quote "$script_dir/tmux-worktree-open.sh") $(tmux_worktree_shell_quote "$session_name") $(tmux_worktree_shell_quote "$worktree_path") $(tmux_worktree_shell_quote "$current_window_id") $(tmux_worktree_shell_quote "$cwd")'"
  menu_args+=("$menu_label" "$accelerator" "$command_string")
  ((item_count += 1))
done

if (( item_count == 0 )); then
  tmux display-message "No git worktrees found for $repo_label"
  exit 0
fi

runtime_log_info worktree "opening worktree menu fallback" "session_name=$session_name" "repo_label=$repo_label" "item_count=$item_count"
runtime_log_info worktree "worktree menu fallback opened" "session_name=$session_name" "repo_label=$repo_label" "item_count=$item_count" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
tmux "${menu_args[@]}"
