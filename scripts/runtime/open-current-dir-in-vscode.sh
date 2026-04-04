#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/tmux-worktree-lib.sh"

usage() {
  cat <<'EOF' >&2
usage:
  open-current-dir-in-vscode.sh [--code-command ARG ... --] [target_dir]
EOF
}

code_command=()
start_ms="$(runtime_log_now_ms)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --code-command)
      shift
      while [[ $# -gt 0 ]]; do
        if [[ "$1" == "--" ]]; then
          shift
          break
        fi
        code_command+=("$1")
        shift
      done
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      usage
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

target_dir="${1:-$PWD}"
runtime_log_info alt_o "open-current-dir-in-vscode invoked" "requested_dir=$target_dir"

if [[ "$target_dir" != /* ]]; then
  runtime_log_error alt_o "expected absolute path" "requested_dir=$target_dir"
  exit 1
fi

if [[ ! -d "$target_dir" ]]; then
  runtime_log_error alt_o "directory does not exist" "requested_dir=$target_dir"
  exit 1
fi

if repo_root="$(tmux_worktree_repo_root "$target_dir" 2>/dev/null || true)" && [[ -n "$repo_root" ]]; then
  target_dir="$repo_root"
fi

runtime_log_info alt_o "resolved Alt+o target directory" "effective_target_dir=$target_dir"

if (( ${#code_command[@]} == 0 )); then
  code_bin="$(command -v code || true)"
  runtime_log_info alt_o "resolved code binary" "code_bin=${code_bin:-missing}"
  if [[ -z "$code_bin" ]]; then
    runtime_log_error alt_o "code binary was not found" "requested_dir=$target_dir"
    exit 1
  fi
  code_command=("$code_bin")
else
  runtime_log_info alt_o "using explicit code command" "code_command=${code_command[*]}"
fi

cd "$target_dir"
runtime_log_info alt_o "changed to effective directory" "effective_dir=$PWD"

runtime_log_info alt_o "executing code from current directory" "effective_dir=$PWD" "code_command=${code_command[*]}"
if "${code_command[@]}" .; then
  runtime_log_info alt_o "open-current-dir-in-vscode completed" "effective_dir=$PWD" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  exit 0
fi

status=$?
runtime_log_error alt_o "open-current-dir-in-vscode failed" "effective_dir=$PWD" "duration_ms=$(runtime_log_duration_ms "$start_ms")" "exit_code=$status"
exit "$status"
