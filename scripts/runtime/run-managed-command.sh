#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"

load_nvm_if_needed() {
  if command -v codex >/dev/null 2>&1; then
    runtime_log_debug managed_command "codex already available on PATH"
    return
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    runtime_log_info managed_command "loading nvm for codex lookup" "nvm_dir=$NVM_DIR"
    # Load nvm so non-interactive tmux startup shells can resolve codex.
    # shellcheck disable=SC1090
    source "$NVM_DIR/nvm.sh"
  fi
}

run_codex_github_theme() {
  runtime_log_info managed_command "launching codex github theme" "arg_count=$#"
  load_nvm_if_needed
  exec codex -c 'tui.theme="github"' "$@"
}

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <launcher> [args...]" >&2
  exit 1
fi

launcher="$1"
shift
runtime_log_info managed_command "run-managed-command invoked" "launcher=$launcher" "arg_count=$#"

case "$launcher" in
  codex-github-theme)
    run_codex_github_theme "$@"
    ;;
  *)
    runtime_log_error managed_command "unknown launcher" "launcher=$launcher"
    echo "unknown launcher: $launcher" >&2
    exit 1
    ;;
esac
