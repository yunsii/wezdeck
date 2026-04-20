#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-worktree-lib.sh"

workspace=""
cwd="${PWD}"
start_ms="$(runtime_log_now_ms)"

usage() {
  cat <<'EOF' >&2
Usage: resolve-vscode-target.sh --workspace NAME --cwd PATH
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --workspace)
      workspace="${2:-}"
      shift 2
      ;;
    --cwd)
      cwd="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$cwd" || "$cwd" != /* ]]; then
  runtime_log_warn vscode "resolve-vscode-target received non-absolute cwd" "workspace=$workspace" "cwd=$cwd"
  exit 1
fi

target_dir="$cwd"
session_name=""
tmux_metadata=""
resolved_session=""
resolved_window=""
resolved_cwd=""

runtime_log_info vscode "resolve-vscode-target invoked" "workspace=$workspace" "cwd=$cwd"

if [[ -n "$workspace" && "$workspace" != "default" ]] && tmux_worktree_in_git_repo "$cwd"; then
  session_name="$(tmux_worktree_session_name_for_path "$workspace" "$cwd" || true)"
  if [[ -n "$session_name" ]] && tmux has-session -t "$session_name" 2>/dev/null; then
    tmux_metadata="$(tmux display-message -p -t "$session_name" '#{session_name}	#{window_id}	#{pane_current_path}' 2>/dev/null || true)"
    if [[ -n "$tmux_metadata" ]]; then
      IFS=$'\t' read -r resolved_session resolved_window resolved_cwd <<< "$tmux_metadata"
      if [[ -n "$resolved_cwd" && -d "$resolved_cwd" ]]; then
        target_dir="$resolved_cwd"
        runtime_log_info vscode "resolved Alt+v target from tmux session" \
          "workspace=$workspace" \
          "session_name=$resolved_session" \
          "window_id=$resolved_window" \
          "resolved_cwd=$resolved_cwd"
      fi
    fi
  else
    runtime_log_info vscode "managed workspace tmux session was unavailable during Alt+v resolution" \
      "workspace=$workspace" \
      "session_name=${session_name:-missing}" \
      "cwd=$cwd"
  fi
fi

if repo_root="$(tmux_worktree_repo_root "$target_dir" 2>/dev/null || true)" && [[ -n "$repo_root" ]]; then
  target_dir="$repo_root"
fi

runtime_log_info vscode "resolved Alt+v target directory" "workspace=$workspace" "effective_target_dir=$target_dir"
runtime_log_info vscode "resolve-vscode-target completed" "workspace=$workspace" "effective_target_dir=$target_dir" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
printf '%s\n' "$target_dir"
