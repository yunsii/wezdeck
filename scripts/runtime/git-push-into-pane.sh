#!/usr/bin/env bash
# Stage `git push` into a tmux pane.
#
# Why staged keys for agent CLI mode (Claude Code / Codex):
#   When the agent CLI receives `!git push\r` in one read() call, its
#   shell-escape detector treats it as a paste rather than a typed `!`,
#   and the trailing `\r` lands as a literal newline inside the chat
#   input instead of submitting the prompt. Splitting `!`, the body,
#   and Enter into three separate `tmux send-keys` calls with brief
#   gaps in between makes each arrive as its own keystroke event.
#
# Logs to LOG_FILE (default /tmp/git-push-into-pane.log) with a
# timestamp + step trace so we can verify the key order if behavior
# regresses.
set -euo pipefail

usage() {
  echo "usage: $0 <agent|shell> <pane-target>" >&2
  exit 2
}

mode="${1-}"
pane="${2-}"
[ -z "$mode" ] || [ -z "$pane" ] && usage

log_file="${GIT_PUSH_INTO_PANE_LOG:-/tmp/git-push-into-pane.log}"
gap_seconds="${GIT_PUSH_INTO_PANE_GAP:-0.1}"

log() {
  printf '%s mode=%s pane=%s step=%s\n' \
    "$(date -Iseconds)" "$mode" "$pane" "$1" >> "$log_file"
}

case "$mode" in
  agent)
    log start
    tmux send-keys -t "$pane" '!'
    log sent_bang
    sleep "$gap_seconds"
    tmux send-keys -t "$pane" 'git push'
    log sent_body
    sleep "$gap_seconds"
    tmux send-keys -t "$pane" Enter
    log sent_enter
    ;;
  shell)
    log start
    tmux send-keys -t "$pane" 'git push' Enter
    log sent_oneshot
    ;;
  *)
    echo "unknown mode: $mode" >&2
    usage
    ;;
esac
