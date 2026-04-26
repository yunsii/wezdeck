#!/usr/bin/env bash

# tmux's show-options / display-message option readers re-escape `$<letter>`
# patterns on every retrieval, so storing raw shell code in an option and
# reading it back mutates the value. Wrap primary-command payloads in
# base64 so the bytes survive the round trip.
tmux_worktree_metadata_encode_primary_command() {
  local value="${1-}"
  [[ -n "$value" ]] || return 0
  printf 'b64:%s' "$(printf '%s' "$value" | base64 | tr -d '\n')"
}

tmux_worktree_metadata_decode_primary_command() {
  local value="${1-}"
  [[ -n "$value" ]] || return 0
  if [[ "${value:0:4}" == "b64:" ]]; then
    printf '%s' "${value:4}" | base64 -d 2>/dev/null
    return
  fi
  printf '%s' "$value"
}

tmux_worktree_set_session_metadata() {
  local session_name="${1:?missing session name}"
  local workspace_name="${2:-}"
  local session_role="${3:-}"

  if [[ -n "$workspace_name" ]]; then
    tmux set-option -t "$session_name" -q @wezterm_workspace "$workspace_name"
  fi

  if [[ -n "$session_role" ]]; then
    tmux set-option -t "$session_name" -q @wezterm_session_role "$session_role"
  fi
}

tmux_worktree_session_metadata() {
  local session_name="${1:?missing session name}"
  local key="${2:?missing metadata key}"
  tmux show-options -v -t "$session_name" "$key" 2>/dev/null || true
}

tmux_worktree_set_window_metadata() {
  local window_target="${1:?missing window target}"
  local window_role="${2:-}"
  local worktree_root="${3:-}"
  local window_label="${4:-}"
  local primary_command="${5:-}"
  local layout="${6:-}"

  if [[ -n "$window_role" ]]; then
    tmux set-window-option -t "$window_target" -q @wezterm_window_role "$window_role"
  fi

  if [[ -n "$worktree_root" ]]; then
    tmux set-window-option -t "$window_target" -q @wezterm_window_root "$worktree_root"
  fi

  if [[ -n "$window_label" ]]; then
    tmux set-window-option -t "$window_target" -q @wezterm_window_label "$window_label"
  fi

  if [[ -n "$primary_command" ]]; then
    tmux set-window-option -t "$window_target" -q @wezterm_window_primary_command \
      "$(tmux_worktree_metadata_encode_primary_command "$primary_command")"
  fi

  if [[ -n "$layout" ]]; then
    tmux set-window-option -t "$window_target" -q @wezterm_window_layout "$layout"
  fi
}

tmux_worktree_window_metadata() {
  local window_target="${1:?missing window target}"
  local key="${2:?missing metadata key}"
  local raw
  raw="$(tmux show-window-options -v -t "$window_target" "$key" 2>/dev/null || true)"
  if [[ "$key" == "@wezterm_window_primary_command" ]]; then
    tmux_worktree_metadata_decode_primary_command "$raw"
    return
  fi
  printf '%s' "$raw"
}

tmux_worktree_find_window() {
  local session_name="${1:?missing session name}"
  local worktree_root="${2:?missing worktree root}"
  local repo_common_dir=""
  local window_context=""
  local window_id=""
  local window_root=""

  repo_common_dir="$(tmux_worktree_common_dir "$worktree_root" || true)"

  while IFS= read -r window_id; do
    [[ -n "$window_id" ]] || continue
    window_context="$(tmux_worktree_window_context "$window_id" "$repo_common_dir" || true)"
    [[ -n "$window_context" ]] || continue
    IFS=$'\t' read -r window_root _ <<< "$window_context"
    if [[ "$window_root" == "$worktree_root" ]]; then
      printf '%s\n' "$window_id"
      return 0
    fi
  done < <(tmux list-windows -t "$session_name" -F '#{window_id}' 2>/dev/null || true)

  return 1
}

# Build a `worktree_root\twindow_id` map for every window in $session_name
# whose panes all live inside the repo identified by $repo_common_dir.
#
# Why: callers that need to look up an existing window for many candidate
# worktree roots (the popup prefetch loop in tmux-worktree-menu.sh) would
# otherwise call `tmux_worktree_find_window` once per candidate, and each
# call re-walks every window/pane in the session and re-runs git resolution
# per pane. This helper does the walk + git resolution once per session,
# deduplicating by pane path so each unique path only spawns git once.
#
# Mirrors `tmux_worktree_window_context`'s rules: a window contributes to
# the index only if every pane resolves to the same (root, common_dir) and
# the common_dir matches $repo_common_dir.
tmux_worktree_build_window_index() {
  local session_name="${1:?missing session name}"
  local repo_common_dir="${2:-}"
  local line=""
  local window_id=""
  local pane_path=""
  local pane_root=""
  local pane_common_dir=""
  local context=""
  local resolved_root=""
  local resolved_common_dir=""
  local prev_window_id=""
  local skip_window=0
  declare -A path_root_cache=()
  declare -A path_common_cache=()
  declare -A window_root=()
  declare -A window_common=()
  declare -A window_skip=()

  while IFS=$'\t' read -r window_id pane_path; do
    [[ -n "$window_id" && -n "$pane_path" && -d "$pane_path" ]] || continue

    if [[ -z "${path_root_cache[$pane_path]+set}" ]]; then
      context="$(tmux_worktree_context_for_path "$pane_path" || true)"
      if [[ -n "$context" ]]; then
        IFS=$'\t' read -r pane_root pane_common_dir _ _ <<< "$context"
      else
        pane_root=""
        pane_common_dir=""
      fi
      path_root_cache[$pane_path]="$pane_root"
      path_common_cache[$pane_path]="$pane_common_dir"
    else
      pane_root="${path_root_cache[$pane_path]}"
      pane_common_dir="${path_common_cache[$pane_path]}"
    fi

    [[ -n "$pane_root" && -n "$pane_common_dir" ]] || continue

    if [[ -z "${window_root[$window_id]+set}" ]]; then
      window_root[$window_id]="$pane_root"
      window_common[$window_id]="$pane_common_dir"
      continue
    fi

    if [[ "${window_root[$window_id]}" != "$pane_root" \
       || "${window_common[$window_id]}" != "$pane_common_dir" ]]; then
      window_skip[$window_id]=1
    fi
  done < <(tmux list-panes -s -t "$session_name" -F '#{window_id}'$'\t''#{pane_current_path}' 2>/dev/null || true)

  for window_id in "${!window_root[@]}"; do
    (( ${window_skip[$window_id]:-0} == 1 )) && continue
    resolved_root="${window_root[$window_id]}"
    resolved_common_dir="${window_common[$window_id]}"
    [[ -n "$resolved_root" && -n "$resolved_common_dir" ]] || continue
    if [[ -n "$repo_common_dir" && "$resolved_common_dir" != "$repo_common_dir" ]]; then
      continue
    fi
    printf '%s\t%s\n' "$resolved_root" "$window_id"
  done
}
