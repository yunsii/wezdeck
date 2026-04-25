#!/usr/bin/env bash
# Shared frame renderer for the tmux worktree popup picker.
#
# Both `tmux-worktree-menu.sh` (pre-renders the very first frame to a tmp
# file so the popup can `cat` it before bash sourcing finishes) and
# `tmux-worktree-picker.sh` (live re-renders on key input) use this so the
# pre-paint and the interactive paint are byte-identical and there is no
# visible swap when the picker takes over.
#
# Caller contract: populate these arrays in the calling shell scope BEFORE
# invoking `worktree_picker_emit_frame`:
#   item_labels item_paths item_branches item_window_ids item_accelerators
# All five arrays must have the same length.

worktree_picker_emit_frame() {
  local cols="$1"
  local visible_rows="$2"
  local selected_index="$3"
  local item_count="$4"
  local current_worktree_root="$5"
  local repo_label="$6"

  local start_index end_index marker line accelerator line_branch line_suffix top_index frame row

  start_index=0
  if (( selected_index >= visible_rows )); then
    start_index=$((selected_index - visible_rows + 1))
  fi
  end_index=$((start_index + visible_rows - 1))
  if (( end_index >= item_count )); then
    end_index=$((item_count - 1))
    start_index=$((end_index - visible_rows + 1))
    if (( start_index < 0 )); then
      start_index=0
    fi
  fi

  row=1
  frame=$'\033['"${row};1H"
  frame+="$(printf '%-*.*s' "$cols" "$cols" "Worktrees: $repo_label")"
  row=$((row + 1))
  frame+=$'\033['"${row};1H"
  frame+="$(printf '%-*.*s' "$cols" "$cols" "Showing $((start_index + 1))-$((end_index + 1)) of $item_count")"
  row=$((row + 2))

  for (( top_index = start_index; top_index <= end_index; top_index += 1 )); do
    marker=' '
    if [[ "${item_paths[$top_index]}" == "$current_worktree_root" ]]; then
      marker='*'
    fi

    accelerator="${item_accelerators[$top_index]}"
    if [[ -n "$accelerator" ]]; then
      accelerator="[$accelerator]"
    else
      accelerator="   "
    fi

    line_branch=""
    if [[ -n "${item_branches[$top_index]}" ]]; then
      line_branch=" [${item_branches[$top_index]}]"
    fi

    line_suffix=""
    if [[ -z "${item_window_ids[$top_index]}" ]]; then
      line_suffix=" (new)"
    fi

    line="$accelerator $marker ${item_labels[$top_index]}$line_branch$line_suffix"
    frame+=$'\033['"${row};1H"
    if (( top_index == selected_index )); then
      frame+=$'\033[7m'"$(printf '%-*.*s' "$cols" "$cols" "$line")"$'\033[0m'
    else
      frame+="$(printf '%-*.*s' "$cols" "$cols" "$line")"
    fi
    row=$((row + 1))
  done

  row=$((row + 1))
  frame+=$'\033['"${row};1H"
  frame+="$(printf '%-*.*s' "$cols" "$cols" "Enter open | Up/Down move | 1-9,0,a-z open | Esc close")"
  frame+=$'\033[J'

  printf '%s' "$frame"
}
