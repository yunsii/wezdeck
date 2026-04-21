#!/usr/bin/env bash
# Keeps the tmux primary pane alive when the managed agent exits under user
# control (clean exit or Ctrl+C kill). Runs the agent as a foreground child,
# then execs the login shell so the pane falls back to a usable prompt instead
# of closing.
#
# Job control (`set -m`) is critical: run-managed-command.sh launches the
# agent via `zsh -ilc`, which enables zsh's own job control and calls
# `tcsetpgrp(tty, agent_pgid)` to hand the tty's foreground process group to
# the agent's pgroup. When the agent exits, that pgroup is gone but the tty's
# fg pgroup still points at it (orphaned). Any subsequent tty operation from
# wrapper (including the exec'd fallback shell's initial tty read) returns
# EIO and the shell dies — taking the pane with it. Enabling job control in
# this wrapper makes bash reclaim tty fg back to the wrapper's pgroup when
# the agent child exits, so the fallback shell inherits a healthy tty.
#
# Signals are handled intentionally narrowly:
#   INT        — trapped and recovered. User pressed Ctrl+C; the agent dies
#                but we want the pane to stay. Fall back to the login shell.
#   HUP / TERM — trapped for logging ONLY, then the wrapper exits so tmux
#                closes the pane cleanly. HUP means the controlling terminal
#                went away (tmux tearing the pane down during
#                `refresh-current-session` or a workspace swap) and TERM is
#                explicit termination. Trying to fall back after these would
#                leave a zombie wrapper attached to a deleted pts; logging the
#                event preserves observability without keeping the pane alive.
#
# Transitions are logged to `category=primary_pane` for post-mortem diagnosis.
#
# Intentionally avoids `set -e`: a mid-wrapper failure must not short-circuit
# the fallback `exec`, or the pane dies — which is the exact class of bug this
# wrapper exists to prevent.
set -muo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"

resolve_login_shell() {
  if [[ -n "${WEZTERM_MANAGED_SHELL:-}" && -x "${WEZTERM_MANAGED_SHELL:-}" ]]; then
    printf '%s\n' "$WEZTERM_MANAGED_SHELL"
    return 0
  fi

  if [[ -n "${SHELL:-}" && -x "${SHELL:-}" ]]; then
    printf '%s\n' "$SHELL"
    return 0
  fi

  local candidate
  for candidate in /bin/zsh /usr/bin/zsh /bin/bash /usr/bin/bash /bin/sh /usr/bin/sh; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '/bin/sh\n'
}

login_shell="$(resolve_login_shell)"

fall_back_to_login_shell() {
  local reason="${1:-unknown}"
  # If the controlling terminal has already been torn down (tmux closed the
  # pty master), exec'ing an interactive shell would immediately hit EOF and
  # exit, leaving a zombie wrapper. Bail out so tmux can finish closing the
  # pane cleanly.
  if [[ ! -t 0 ]]; then
    runtime_log_info primary_pane "fallback skipped: no tty" "pid=$$" "reason=$reason"
    exit 0
  fi
  runtime_log_info primary_pane "exec fallback shell" "pid=$$" "reason=$reason" "login_shell=$login_shell"
  # Reset terminal state in case the agent left it in raw/non-cooked mode.
  # Without this, the exec'd shell can appear frozen to the user (no echo,
  # no line buffering).
  stty sane 2>/dev/null || true
  exec "$login_shell" -l
}

on_int() {
  runtime_log_info primary_pane "trap fired" "pid=$$" "sig=INT"
  fall_back_to_login_shell "signal=INT"
}

# HUP / TERM are log-and-exit: observability without hijacking pane teardown.
on_terminating_signal() {
  local sig="$1"
  runtime_log_info primary_pane "wrapper terminating on signal" "pid=$$" "sig=$sig"
  # 128 + signal number, matching the convention bash uses for signal-induced
  # exits (HUP=1 → 129, TERM=15 → 143).
  case "$sig" in
    HUP) exit 129 ;;
    TERM) exit 143 ;;
    *) exit 1 ;;
  esac
}

trap on_int INT
trap 'on_terminating_signal HUP' HUP
trap 'on_terminating_signal TERM' TERM

runtime_log_info primary_pane "wrapper entered" "pid=$$" "login_shell=$login_shell" "argc=$#"

if [[ $# -eq 0 ]]; then
  fall_back_to_login_shell "no_agent_command"
fi

runtime_log_info primary_pane "invoking agent" "pid=$$" "command=$1"
"$@"
rc=$?
runtime_log_info primary_pane "agent returned" "pid=$$" "rc=$rc"

fall_back_to_login_shell "agent_returned_rc=$rc"
