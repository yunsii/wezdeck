#!/usr/bin/env bash
# Ctrl+n decision point for tmux-backed panes.
#
# WezTerm always forwards \x0e here (see manifest `agent.new-conversation`).
# This script evaluates @agent_pane_match, logs the decision, then either
# stages `/new`+Enter (agent) or injects `clear`+Enter (non-agent). Without
# this log, a missing @wezterm_pane_role on a resume-wrapper pane
# (leaf=sh/node) silently falls through and is indistinguishable from
# "user pressed Ctrl+n in a shell" after the fact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="agent-ctrl-n.sh"

usage() {
  echo "usage: $0 <pane-or-window-target>" >&2
  exit 2
}

target="${1-}"
[[ -n "$target" ]] || usage

# Resolve to a concrete pane id so logs stay comparable across calls
# (window targets would otherwise bounce between active panes).
pane_id="$(tmux display-message -p -t "$target" '#{pane_id}' 2>/dev/null || true)"
if [[ -z "$pane_id" ]]; then
  runtime_log_warn agent_cli "Ctrl+n aborted: target pane unavailable" "target=$target"
  exit 0
fi

match="$(tmux display-message -p -t "$pane_id" '#{E:#{@agent_pane_match}}' 2>/dev/null || true)"
cmd="$(tmux display-message -p -t "$pane_id" '#{pane_current_command}' 2>/dev/null || true)"
role="$(tmux show-options -p -t "$pane_id" -v -q @wezterm_pane_role 2>/dev/null || true)"
cwd="$(tmux display-message -p -t "$pane_id" '#{pane_current_path}' 2>/dev/null || true)"
session_name="$(tmux display-message -p -t "$pane_id" '#{session_name}' 2>/dev/null || true)"
window_id="$(tmux display-message -p -t "$pane_id" '#{window_id}' 2>/dev/null || true)"
primary_meta=""
if [[ -n "$window_id" ]]; then
  # Decode via the same helper open/refresh paths use, when available.
  if [[ -f "$SCRIPT_DIR/tmux-worktree/metadata.sh" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/tmux-worktree/metadata.sh"
    if declare -F tmux_worktree_window_metadata >/dev/null 2>&1; then
      primary_meta="$(tmux_worktree_window_metadata "$window_id" @wezterm_window_primary_command 2>/dev/null || true)"
    fi
  fi
  if [[ -z "$primary_meta" ]]; then
    primary_meta="$(tmux show-options -w -t "$window_id" -v -q @wezterm_window_primary_command 2>/dev/null || true)"
  fi
fi

common_fields=(
  "pane_id=$pane_id"
  "session_name=$session_name"
  "window_id=$window_id"
  "cwd=$cwd"
  "pane_current_command=$cmd"
  "pane_role=${role:-}"
  "agent_pane_match=${match:-0}"
  "primary_command=${primary_meta:-}"
)

if [[ "$match" == "1" ]]; then
  runtime_log_info agent_cli "Ctrl+n matched agent pane; staging /new" "${common_fields[@]}"
  bash "$SCRIPT_DIR/agent-new-into-pane.sh" "$pane_id"
  exit 0
fi

# Suspected miss: resume wrapper leaf (sh/node) + managed primary metadata
# but no role tag → exactly the Alt+g tagging gap. Do NOT inject `clear`
# into a likely agent composer; keep C-n pass-through and warn so a later
# "Ctrl+n did nothing" report is greppable without turning on debug.
cmd_base="${cmd##*/}"
suspected_miss=0
case "$cmd_base" in
  sh|node|ash|dash)
    if [[ -z "$role" && -n "$primary_meta" ]]; then
      suspected_miss=1
    fi
    ;;
esac

if [[ "$suspected_miss" == "1" ]]; then
  runtime_log_warn agent_cli \
    "Ctrl+n pass-through on suspected agent pane (missing @wezterm_pane_role?)" \
    "${common_fields[@]}" \
    "hint=tag_or_refresh"
  tmux send-keys -t "$pane_id" C-n
  exit 0
fi

runtime_log_info agent_cli "Ctrl+n non-agent pane; injecting clear" "${common_fields[@]}"
tmux send-keys -t "$pane_id" 'clear' Enter
