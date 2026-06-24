#!/usr/bin/env bash
# Stage `/new` into a tmux pane.
#
# Codex treats `/new` + Enter sent in one batch as text plus a literal
# newline in the composer. Splitting body and Enter into separate
# send-keys calls makes the submit look like typed keystrokes.
set -euo pipefail

usage() {
  echo "usage: $0 <pane-target>" >&2
  exit 2
}

pane="${1-}"
[ -n "$pane" ] || usage

gap_seconds="${AGENT_NEW_INTO_PANE_GAP:-0.1}"

tmux send-keys -t "$pane" '/new'
sleep "$gap_seconds"
tmux send-keys -t "$pane" Enter
