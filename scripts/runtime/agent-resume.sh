#!/usr/bin/env bash
# Run an interactive agent's resume command and fall back to a fresh session.
#
# Prefer a pane-bound session id (typed resume) over cwd-scoped --continue:
#   WEZDECK_RESUME_SESSION_ID → window pin → attention.json → --continue → fresh
#
# Typed path uses exec: a failed/invalid id returns to primary-pane-wrapper
# (login shell) instead of silently opening a different cwd --continue session.

set -euo pipefail

agent="${1:?missing agent}"
fallback_log="${2:?missing fallback log}"
agent_bin="${3:?missing agent binary}"
mode="${4:-base}"
shift 4

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$script_dir/agent-session-resolve.sh"
# shellcheck disable=SC1091
. "$script_dir/runtime-log-lib.sh" 2>/dev/null || true

session_id="$(agent_session_resolve_current || true)"

log_resume() {
  local message="$1"
  shift
  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info primary_pane "$message" \
      "agent=$agent" "cwd=$PWD" "$@" || true
  fi
}

if agent_session_id_usable "${session_id:-}"; then
  log_resume "agent resume typed" \
    "resume_mode=typed" "session_id=$session_id"
  if [[ -n "${TMUX_PANE:-}" ]]; then
    agent_session_pin_pane "$TMUX_PANE" "$session_id" "$agent" "$PWD"
  fi
  exec "$agent_bin" "$@" --resume "$session_id"
fi

log_resume "agent resume continue" "resume_mode=continue"
"$agent_bin" "$@" --continue || {
  bash "$fallback_log" "$agent"
  printf '\033[2J\033[H\n\n  \033[2;36mLoading %s ...\033[0m\n  \033[2;36mMode: %s\033[0m\n' \
    "$agent" "$mode"
  exec "$agent_bin" "$@"
}
