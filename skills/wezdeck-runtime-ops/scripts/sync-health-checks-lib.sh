#!/usr/bin/env bash
# sync-health-checks-lib.sh
#
# Advisory post-sync health checks for sync-runtime.sh. Each one only warns
# (sync_trace status=warning + a fix hint on stderr) and never fails the sync;
# each has its own WEZTERM_SYNC_SKIP_* override. Sourced (do not execute).
#
# Requires from the caller: sync_trace, $REPO_ROOT, and runtime-log-lib.sh
# (runtime_log_info / runtime_log_warn) — resolved at call time, so this file
# only has to be sourced before the run_* functions are invoked.
#
# Public functions used by sync-runtime.sh:
#   run_agent_hooks_check        → Claude / Codex attention hooks installed
#   run_repo_hygiene_hook_check  → installed pre-commit hook matches source
#   run_attention_health_check   → attention live-panes / orphan mux
#   run_shell_env_check          → managed shell-env.d loading
#   run_node_runtime_check       → node runtime for agent CLIs

run_agent_hooks_check() {
  local check_script="$REPO_ROOT/scripts/dev/agent-hooks.sh"
  local output=""
  local rc=0

  if [[ "${WEZTERM_SYNC_SKIP_AGENT_HOOK_CHECK:-0}" == "1" ]]; then
    sync_trace "step=agent-hooks-check status=skipped reason=env_override"
    return 0
  fi
  if [[ ! -x "$check_script" ]]; then
    sync_trace "step=agent-hooks-check status=skipped reason=script_missing"
    return 0
  fi

  output="$("$check_script" check --provider all --quiet 2>&1)" || rc=$?
  if (( rc == 0 )); then
    sync_trace "step=agent-hooks-check status=healthy providers=claude,codex"
    runtime_log_info sync "agent hooks check passed" "providers=claude,codex"
    return 0
  fi

  sync_trace "step=agent-hooks-check status=warning rc=$rc providers=claude,codex"
  runtime_log_warn sync "agent hooks check warning" \
    "providers=claude,codex" "check_rc=$rc"
  printf '[sync] agent-hooks-check warning (sync continues):\n%s\n' \
    "${output:-agent-hooks check failed without details}" >&2
  printf '[sync] fix: %s install --provider codex|claude|all\n' "$check_script" >&2
}

# Advisory: the shared pre-commit hook is a *copy* of
# skills/repo-hygiene/hooks/pre-commit. When the tracked source changes, the
# installed copy goes stale and can silently skip every commit gate (the
# runner moved out of scripts/dev/ and nobody noticed until 2026-11-14).
# Never fails the sync.
run_repo_hygiene_hook_check() {
  local check_script="$REPO_ROOT/skills/repo-hygiene/run.sh"
  local output=""
  local rc=0

  if [[ "${WEZTERM_SYNC_SKIP_HYGIENE_HOOK_CHECK:-0}" == "1" ]]; then
    sync_trace "step=repo-hygiene-hook-check status=skipped reason=env_override"
    return 0
  fi
  if [[ ! -x "$check_script" ]]; then
    sync_trace "step=repo-hygiene-hook-check status=skipped reason=script_missing"
    return 0
  fi

  output="$("$check_script" hook-status 2>&1)" || rc=$?
  if (( rc == 0 )); then
    sync_trace "step=repo-hygiene-hook-check status=healthy"
    return 0
  fi

  sync_trace "step=repo-hygiene-hook-check status=warning rc=$rc"
  runtime_log_warn sync "repo-hygiene hook check warning" "check_rc=$rc"
  printf '[sync] repo-hygiene-hook-check warning (sync continues):\n%s\n' \
    "${output:-hook-status failed without details}" >&2
}

# Advisory: sparse live-panes / orphan mux that used to wipe attention
# badges within ~1s (2026-10-09). Never fails the sync.
run_attention_health_check() {
  local check_script="$REPO_ROOT/scripts/dev/attention-health.sh"
  local output=""
  local rc=0

  if [[ "${WEZTERM_SYNC_SKIP_ATTENTION_HEALTH:-0}" == "1" ]]; then
    sync_trace "step=attention-health-check status=skipped reason=env_override"
    return 0
  fi
  if [[ ! -x "$check_script" ]]; then
    sync_trace "step=attention-health-check status=skipped reason=script_missing"
    return 0
  fi

  output="$("$check_script" --quiet 2>&1)" || rc=$?
  if (( rc == 0 )); then
    sync_trace "step=attention-health-check status=healthy"
    runtime_log_info sync "attention health check passed"
    return 0
  fi

  sync_trace "step=attention-health-check status=warning rc=$rc"
  runtime_log_warn sync "attention health check warning" "check_rc=$rc"
  printf '[sync] attention-health-check warning (sync continues):\n%s\n' \
    "${output:-attention-health check failed without details}" >&2
  printf '[sync] triage: %s  |  docs/diagnostics.md (live-panes orphan mux)\n' \
    "$check_script" >&2
}

run_shell_env_check() {
  local check_script="$REPO_ROOT/scripts/dev/check-shell-env.sh"
  local output=""
  local rc=0

  if [[ "${WEZTERM_SYNC_SKIP_SHELL_ENV_CHECK:-0}" == "1" ]]; then
    sync_trace "step=shell-env-check status=skipped reason=env_override"
    return 0
  fi
  if [[ ! -x "$check_script" ]]; then
    sync_trace "step=shell-env-check status=skipped reason=script_missing"
    return 0
  fi

  output="$("$check_script" --advisory 2>&1)" || rc=$?
  if (( rc != 0 )) || [[ "$output" == *'warning:'* ]]; then
    sync_trace "step=shell-env-check status=warning rc=$rc"
    runtime_log_warn sync "shell-env check warning" "check_rc=$rc"
    printf '[sync] shell-env-check warning (sync continues):\n%s\n' \
      "${output:-shell-env check failed without details}" >&2
    return 0
  fi

  sync_trace "step=shell-env-check status=healthy"
  runtime_log_info sync "shell-env check passed"
}

run_node_runtime_check() {
  local check_script="$REPO_ROOT/scripts/dev/check-node-runtime.sh"
  local details=""
  local output=""
  local rc=0

  if [[ "${WEZTERM_SYNC_SKIP_NODE_RUNTIME_CHECK:-0}" == "1" ]]; then
    sync_trace "step=node-runtime-check status=skipped reason=env_override"
    return 0
  fi
  if [[ ! -x "$check_script" ]]; then
    sync_trace "step=node-runtime-check status=skipped reason=script_missing"
    return 0
  fi

  output="$("$check_script" --advisory 2>&1)" || rc=$?
  if (( rc != 0 )); then
    sync_trace "step=node-runtime-check status=warning rc=$rc"
    runtime_log_warn sync "node runtime check warning" "check_rc=$rc"
    printf '[sync] node-runtime-check warning (sync continues):\n%s\n' \
      "${output:-node runtime check failed without details}" >&2
    return 0
  fi

  if [[ "$output" == *'warning:'* ]]; then
    sync_trace "step=node-runtime-check status=warning"
    details="$(printf '%s' "$output" | tr '\n' ' ' | cut -c1-240)"
    runtime_log_warn sync "node runtime check warning" "details=$details"
    printf '%s\n' "$output" >&2
  else
    sync_trace "step=node-runtime-check status=healthy"
    runtime_log_info sync "node runtime check passed"
  fi
}
