#!/usr/bin/env bash
# Remove Codex writer locks before starting a managed resume. Codex locks are
# empty marker files and do not provide a usable PID, so find old resume
# process groups by command line instead of relying on fuser.

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

terminate_resume_process_groups() {
  local own_pgid=""
  own_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]')"
  local pid pgid args
  declare -A groups=()

  while read -r pid pgid args; do
    [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ ]] || continue
    [[ "$pgid" != "$own_pgid" ]] || continue
    [[ "$args" =~ codex[[:space:]]+([^[:space:]]+[[:space:]]+)*resume([[:space:]]|$) ]] || continue
    [[ "$args" != *"codex-resume-takeover.sh"* ]] || continue
    groups["$pgid"]="$args"
  done < <(ps -eo pid=,pgid=,args= 2>/dev/null)

  local group remaining
  for group in "${!groups[@]}"; do
    kill -CONT -- "-$group" 2>/dev/null || true
    kill -TERM -- "-$group" 2>/dev/null || true
    remaining=0
    while (( remaining < 30 )); do
      kill -0 -- "-$group" 2>/dev/null || break
      sleep 0.1
      remaining=$((remaining + 1))
    done
    if kill -0 -- "-$group" 2>/dev/null; then
      kill -KILL -- "-$group" 2>/dev/null || true
    fi
    log_event warn "terminated codex resume process group" \
      "pgid=$group" "command=${groups[$group]}" "signal=TERM_KILL"
  done
}

take_over_locks() {
  [[ -d "$lock_dir" ]] || return 0
  local lock base
  local lock_count=0
  terminate_resume_process_groups
  while IFS= read -r -d '' lock; do
    base="${lock##*/}"
    ((lock_count += 1))
    rm -f -- "$lock"
    log_event info "codex resume lock taken over" \
      "lock_file=$lock" "thread_id=${base%.lock}" "holder_action=process_group_terminate_then_remove"
  done < <(find "$lock_dir" -maxdepth 1 -type f -name '*.lock' -print0 2>/dev/null)
  if (( lock_count > 0 )); then
    log_event info "codex resume locks cleared" "lock_count=$lock_count" "codex_home=$codex_home"
  fi
}

take_over_locks
exec "$@"
