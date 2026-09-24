#!/usr/bin/env bash
# Remove Codex writer locks before starting an explicitly managed resume.
# Codex locks are empty marker files; the conversation data lives under
# $CODEX_HOME/sessions. A live holder is terminated before its marker is
# removed so the new process cannot race it while appending the rollout.

set -eu

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$script_dir/runtime-log-lib.sh" 2>/dev/null || true
WEZTERM_RUNTIME_LOG_SOURCE="${WEZTERM_RUNTIME_LOG_SOURCE:-codex-resume-takeover.sh}"

codex_home="${CODEX_HOME:-$HOME/.codex}"
lock_dir="$codex_home/thread-writer-locks"

log_event() {
  local level="$1"
  shift
  if declare -F runtime_log_"$level" >/dev/null 2>&1; then
    runtime_log_"$level" primary_pane "$@" || true
  fi
}

terminate_holders() {
  local lock="$1"
  local holders=""
  local pid=""

  command -v fuser >/dev/null 2>&1 || return 0
  holders="$(fuser "$lock" 2>/dev/null || true)"
  holders="${holders//[^0-9 ]/}"
  for pid in $holders; do
    [[ "$pid" == "$$" ]] && continue
    kill -TERM "$pid" 2>/dev/null || true
  done

  if [[ -n "$holders" ]]; then
    local deadline=$((SECONDS + 3))
    while (( SECONDS < deadline )); do
      local remaining="$(fuser "$lock" 2>/dev/null || true)"
      remaining="${remaining//[^0-9 ]/}"
      [[ -z "$remaining" ]] && break
      sleep 0.1
    done
    for pid in $remaining; do
      [[ "$pid" == "$$" ]] && continue
      kill -KILL "$pid" 2>/dev/null || true
    done
  fi
}

take_over_locks() {
  [[ -d "$lock_dir" ]] || return 0
  local lock base
  local lock_count=0
  while IFS= read -r -d '' lock; do
    base="${lock##*/}"
    ((lock_count += 1))
    terminate_holders "$lock"
    rm -f -- "$lock"
    log_event info "codex resume lock taken over" \
      "lock_file=$lock" "thread_id=${base%.lock}" "holder_action=terminate_then_remove"
  done < <(find "$lock_dir" -maxdepth 1 -type f -name '*.lock' -print0 2>/dev/null)
  if (( lock_count > 0 )); then
    log_event info "codex resume locks cleared" "lock_count=$lock_count" "codex_home=$codex_home"
  fi
}

take_over_locks
exec "$@"
