#!/usr/bin/env bash
# pane-died hook: a pane process exited on its own (shell Ctrl+D, agent
# Ctrl+C / quit, a bad F5 respawn command). tmux's default remain-on-exit
# is off, so that exit destroys the pane. This script turns the dead pane
# back into a login shell in place.
#
# Secondary agent exit also drops typed-resume sources (pane option,
# durable secondary pin, attention live+recent, pane role tag) so a later
# F5 stays a shell. Primary keeps pins — F5 is the bring-back path there.
#
# Intentional teardown does not come here. respawn-pane -k and kill-pane
# do not fire pane-died, so F5 refresh and Ctrl+k x still replace or
# close the pane.
#
# Invoked as:
#   pane-exit-keep.sh <socket> <pane-id> <cwd>
# Exit status is read from the pane (#{pane_dead_status}). This tmux
# build has hook_pane but not hook_pane_dead_status.
# stdout stays empty: the caller is `run-shell -b`.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/managed-shell-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="pane-exit-keep.sh"

socket_path="${1:-}"
pane_id="${2:-}"
cwd="${3:-}"

if [[ -z "$socket_path" || -z "$pane_id" ]]; then
  exit 0
fi

tmux_cmd=(tmux -S "$socket_path")

# Another client (or a racing hook) may already have replaced the pane.
pane_state="$("${tmux_cmd[@]}" display-message -p -t "$pane_id" '#{pane_dead} #{pane_floating_flag} #{pane_dead_status}' 2>/dev/null || true)"
read -r pane_dead pane_floating dead_status <<<"$pane_state"
if [[ "$pane_dead" != "1" ]]; then
  exit 0
fi

# Floating panes (tmux 3.8 new-pane / Ctrl+drag) are transient overlays,
# not layout slots: keeping them alive would make `exit` unable to close
# them. Let them go, the way worktree-sidebar.sh turns remain-on-exit off.
if [[ "$pane_floating" == "1" ]]; then
  "${tmux_cmd[@]}" kill-pane -t "$pane_id" 2>/dev/null || true
  runtime_log_info workspace "pane exit keep skipped floating pane" \
    "pane_id=$pane_id" \
    "dead_status=${dead_status:-}" \
    "outcome=closed_floating"
  exit 0
fi

login_shell="$(resolve_login_shell)"
# Keep the hook-reported path for typed-resume release before falling
# back to $HOME for the login-shell respawn (dead panes sometimes lose
# pane_current_path, which would otherwise clear the wrong pin key).
release_cwd="$cwd"
if [[ -z "$cwd" || ! -d "$cwd" ]]; then
  cwd="${HOME:-/tmp}"
fi

start_ms="$(runtime_log_now_ms)"
runtime_log_info workspace "pane exit keep invoked" \
  "pane_id=$pane_id" \
  "dead_status=${dead_status:-}" \
  "cwd=$cwd" \
  "release_cwd=${release_cwd:-}" \
  "login_shell=$login_shell"

# Release secondary typed-resume while the dead pane (and its options)
# still exist. Primary is left alone so F5 can bring the agent back.
# Route bare `tmux` in the resolve helpers to this hook's socket — the
# pane-died run-shell may not have TMUX pointing at the owning server
# (isolated test sockets, multi-server hosts).
tmux() { command tmux -S "$socket_path" "$@"; }
# shellcheck disable=SC1091
source "$SCRIPT_DIR/agent-session-resolve.sh" 2>/dev/null || true
if declare -F agent_session_release_secondary_on_exit >/dev/null 2>&1; then
  agent_session_release_secondary_on_exit "$pane_id" "$release_cwd" || true
fi
unset -f tmux

ec=0
"${tmux_cmd[@]}" respawn-pane -k -t "$pane_id" -c "$cwd" "$login_shell" -l || ec=$?
duration_ms="$(runtime_log_duration_ms "$start_ms")"

if [[ "$ec" -ne 0 ]]; then
  runtime_log_warn workspace "pane exit keep failed" \
    "pane_id=$pane_id" \
    "dead_status=${dead_status:-}" \
    "exit_code=$ec" \
    "duration_ms=$duration_ms"
  exit 0
fi

runtime_log_info workspace "pane exit keep completed" \
  "pane_id=$pane_id" \
  "dead_status=${dead_status:-}" \
  "duration_ms=$duration_ms" \
  "outcome=respawned_shell" \
  "login_shell=$login_shell"
exit 0
