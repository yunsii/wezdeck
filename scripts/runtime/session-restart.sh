#!/usr/bin/env bash
# The web console's 重启会话 / 新开会话 for one session's pane (relay
# `session.restart`, native/wezdeck-wsl/session_restart.go). The same chains
# as the desk keys, aimed at a pane instead of the focused one:
#
#   (default)  F5            → respawn in place, the agent resumes its
#                              conversation (tmux-reset refresh-current-window)
#   --fresh    Ctrl+Shift+n  → unpin typed resume, cold-respawn a blank agent
#                              (agent-ctrl-n.sh --fresh)
#
# Both act on a window's active pane, so the target pane is selected first —
# the one visible side effect at the desk besides the respawn itself.
#
# --fresh on Claude names the new conversation up front: a UUID goes into the
# pane option @wezdeck_fresh_session_id, agent-resume.sh starts
# `claude --session-id <it>`, and once the respawn succeeded the old entry is
# archived and marked cleared_to that id (as SessionStart clear does), so the
# relay answers the old id with replaced_by and the page follows before the
# new conversation's first prompt.
#
# The tmux server is the caller's: the relay sets TMUX to the session's socket.
# stdout: key=value lines — outcome=<respawned|…> and, for a named fresh
# start, session_id=<uuid>. Exit 1 when nothing was respawned.
#
#   session-restart.sh [--fresh] [--agent claude|codex|grok|agy] --pane %N
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
source "$SCRIPT_DIR/attention-state-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="session-restart.sh"

fresh=0
agent=""
pane=""
while (($#)); do
  case "$1" in
    --fresh) fresh=1 ;;
    --agent) agent="${2-}"; shift ;;
    --pane) pane="${2-}"; shift ;;
    *) echo "usage: $0 [--fresh] [--agent NAME] --pane %N" >&2; exit 2 ;;
  esac
  shift
done
[[ "$pane" =~ ^%[0-9]+$ ]] || { echo "session-restart: bad pane '$pane'" >&2; exit 2; }

read -r session_name window_id socket cwd < <(tmux display-message -p -t "$pane" \
  '#{session_name} #{window_id} #{socket_path} #{pane_current_path}' 2>/dev/null) || true
if [[ -z "${window_id:-}" ]]; then
  echo "session-restart: pane $pane is gone" >&2
  exit 1
fi

start_ms="$(runtime_log_now_ms)"
mode=resume
((fresh)) && mode=fresh
fields=("pane=$pane" "session_name=$session_name" "window_id=$window_id" "mode=$mode" "agent=${agent:-}")
attention_state_mark_restart_pending "${WEZDECK_RESTART_SESSION_ID:-}" 2>/dev/null || true
runtime_log_info workspace "web session restart invoked" "${fields[@]}"

finish() {
  local outcome="$1" level="${2:-info}"
  "runtime_log_$level" workspace "web session restart completed" "${fields[@]}" \
    "duration_ms=$(runtime_log_duration_ms "$start_ms")" "outcome=$outcome"
  printf 'outcome=%s\n' "$outcome"
}

tmux select-pane -t "$pane" 2>/dev/null || true

if ((!fresh)); then
  out="$(bash "$SCRIPT_DIR/tmux-reset.sh" refresh-current-window \
    --session-name "$session_name" --window-id "$window_id" --cwd "${cwd:-}" 2>/dev/null)" || true
  out="${out//$'\r'/}"
  attention_state_clear_restart_pending "${WEZDECK_RESTART_SESSION_ID:-}" 2>/dev/null || true
  if [[ "${out##*$'\n'}" == "reset_window_in_place" ]]; then
    finish respawned
    exit 0
  fi
  finish "failed:${out##*$'\n'}" warn
  exit 1
fi

new_id="$(cat /proc/sys/kernel/random/uuid)"
if [[ "$agent" == claude* ]]; then
  tmux set-option -p -t "$pane" @wezdeck_fresh_session_id "$new_id"
else
  # Codex and Grok choose their own id after the first prompt. Until then,
  # this id lets the web console address the fresh, empty pane.
  new_id="pending-$new_id"
fi
out="$(AGENT_CTRL_N_PRINT_OUTCOME=1 bash "$SCRIPT_DIR/agent-ctrl-n.sh" --fresh "$pane" 2>/dev/null)" || true
outcome="$(sed -n 's/^outcome=//p' <<<"$out" | tail -1)"
case "$outcome" in
  fresh|fresh_*) [[ "$outcome" == *_failed ]] && outcome="" ;;
  *) outcome="" ;;
esac
if [[ -z "$outcome" ]]; then
  tmux set-option -p -u -t "$pane" @wezdeck_fresh_session_id 2>/dev/null || true
  attention_state_clear_restart_pending "${WEZDECK_RESTART_SESSION_ID:-}" 2>/dev/null || true
  finish "failed:$(sed -n 's/^outcome=//p' <<<"$out" | tail -1)" warn
  exit 1
fi
if [[ -n "$new_id" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/attention-state-lib.sh"
  attention_state_evict_session "$socket" "$session_name" "$new_id" "$pane" 2>/dev/null || true
  attention_mark_cleared "$socket" "$pane" "$new_id" 2>/dev/null || true
  printf 'session_id=%s\n' "$new_id"
fi
finish respawned
