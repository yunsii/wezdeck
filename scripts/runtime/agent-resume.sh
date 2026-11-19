#!/usr/bin/env bash
# Run an interactive agent's resume command and fall back to a fresh session.
#
# Prefer a pane-bound session id (typed resume) over cwd-scoped --continue:
#   WEZDECK_RESUME_SESSION_ID → window pin → attention.json → --continue → fresh
#
# WEZDECK_FORCE_FRESH_SESSION=1 skips typed resume and --continue (recycle
# --fresh-agent / F5 after unpin). Used so a round reset does not need a
# manual Ctrl+n + F5.
#
# Typed path uses exec: a failed/invalid id returns to primary-pane-wrapper
# (login shell) instead of silently opening a different cwd --continue session.

set -euo pipefail

agent="${1:?missing agent}"
fallback_log="${2:?missing fallback log}"
agent_bin="${3:?missing agent binary}"
mode="${4:-base}"
shift 4
agent_args=("$@")

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$script_dir/agent-session-resolve.sh"
# shellcheck disable=SC1091
. "$script_dir/runtime-log-lib.sh" 2>/dev/null || true

log_resume() {
  local message="$1"
  shift
  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info primary_pane "$message" \
      "agent=$agent" "cwd=$PWD" "$@" || true
  fi
}

start_fresh() {
  local reason="${1:-}"
  log_resume "agent resume fresh" "resume_mode=fresh" "${reason:+$reason}"
  bash "$fallback_log" "$agent" 2>/dev/null || true
  printf '\033[2J\033[H\n\n  \033[2;36mLoading %s ...\033[0m\n  \033[2;36mMode: %s\033[0m\n' \
    "$agent" "$mode"
  exec "$agent_bin" "${agent_args[@]+"${agent_args[@]}"}"
}

if [[ "${WEZDECK_FORCE_FRESH_SESSION:-0}" == "1" ]]; then
  start_fresh "force=WEZDECK_FORCE_FRESH_SESSION"
fi

session_id="$(agent_session_resolve_current || true)"

if agent_session_id_usable "${session_id:-}"; then
  # Claude: refuse typed resume when the transcript jsonl is gone. A bare
  # pin / .wakatime sidecar still looks "usable" as an id, but
  # `claude --resume <id>` then exits immediately and primary-pane-wrapper
  # drops into a login shell — the pane never reaches agent state.
  if [[ "$agent" == claude* ]] \
    && ! agent_session_claude_transcript_exists "$session_id" "$PWD"; then
    log_resume "agent resume typed skipped; transcript missing" \
      "resume_mode=typed_skip_missing_transcript" "session_id=$session_id"
    agent_session_forget_typed_id "$session_id" "${TMUX_PANE:-}" "$PWD" || true
    session_id=""
  else
    log_resume "agent resume typed" \
      "resume_mode=typed" "session_id=$session_id"
    if [[ -n "${TMUX_PANE:-}" ]]; then
      agent_session_pin_pane "$TMUX_PANE" "$session_id" "$agent" "$PWD"
    fi
    exec "$agent_bin" "${agent_args[@]+"${agent_args[@]}"}" --resume "$session_id"
  fi
fi

log_resume "agent resume continue" "resume_mode=continue"
"$agent_bin" "${agent_args[@]+"${agent_args[@]}"}" --continue || {
  start_fresh "from=continue_fallback"
}
