#!/usr/bin/env bash
# tmux 3.8 OSC 133 → agent-attention pilot.
#
# Maps pane-command-started / pane-command-finished / pane-shell-prompt into
# emit.sh running|done for panes tagged agent-cli:grok*. Claude/Codex keep
# their vendor hooks; this path is a gap-filler only.
#
# Gate (off by default):
#   tmux set -g @wezdeck_osc133_attention 1
#
# Invoked from tmux.conf:
#   run-shell -b "bash …/osc133-tmux-hook.sh <started|finished|prompt> #{q:hook_pane} #{q:socket_path}"
# stdout must stay empty (run-shell).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

event="${1:-}"
pane_id="${2:-}"
socket_path="${3:-}"

case "$event" in
  started|finished|prompt) ;;
  *) exit 0 ;;
esac
[[ -n "$pane_id" ]] || exit 0

if [[ -n "$socket_path" ]]; then
  tmux_cmd=(tmux -S "$socket_path")
else
  tmux_cmd=(tmux)
fi

enabled="$("${tmux_cmd[@]}" show-options -gv @wezdeck_osc133_attention 2>/dev/null || true)"
case "${enabled:-}" in
  1|on|true|yes) ;;
  *) exit 0 ;;
esac

role="$("${tmux_cmd[@]}" show-options -p -t "$pane_id" -v -q @wezterm_pane_role 2>/dev/null || true)"
case "$role" in
  agent-cli:grok|agent-cli:grok-*) ;;
  *) exit 0 ;;
esac

# Prefer typed session pin; fall back to a stable osc133-scoped key.
session_id="$("${tmux_cmd[@]}" show-options -p -t "$pane_id" -v -q @wezterm_agent_session_id 2>/dev/null || true)"
if [[ -z "$session_id" || "$session_id" == pane:* ]]; then
  session_id="osc133:${pane_id}"
fi

status=""
reason=""
case "$event" in
  started)
    status="running"
    reason="osc133:command-started"
    ;;
  finished)
    status="done"
    reason="osc133:command-finished"
    ;;
  prompt)
    # Shell prompt after a command — treat as turn idle for badge purposes.
    status="done"
    reason="osc133:shell-prompt"
    ;;
esac
[[ -n "$status" ]] || exit 0

export TMUX_PANE="$pane_id"
# run-shell usually inherits TMUX; if not, still pass socket via env for
# nested tmux calls inside emit (display-message uses default client).
if [[ -n "$socket_path" && -z "${TMUX:-}" ]]; then
  export TMUX="${socket_path},,"
fi

# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/runtime/runtime-log-lib.sh" 2>/dev/null || true
export WEZTERM_RUNTIME_LOG_SOURCE="osc133-tmux-hook.sh"
if command -v runtime_log_info >/dev/null 2>&1; then
  runtime_log_info attention "osc133 hook" \
    "event=$event" \
    "status=$status" \
    "pane_id=$pane_id" \
    "role=$role" \
    "session_id=$session_id" || true
fi

exec bash "$SCRIPT_DIR/emit.sh" \
  --provider grok \
  --session-id "$session_id" \
  --raw-event "osc133_${event}" \
  --reason "$reason" \
  "$status"
