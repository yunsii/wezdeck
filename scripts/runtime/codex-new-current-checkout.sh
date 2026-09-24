#!/usr/bin/env bash
# Select "Current checkout" when Codex's /new flow asks where to run.
#
# This is intentionally a pane-level UI fallback: Codex does not expose the
# transient chooser state through its session files or a supported API.
set -euo pipefail

usage() {
  echo "usage: $0 <pane-target>" >&2
  exit 2
}

pane="${1-}"
[[ -n "$pane" ]] || usage

poll_s="${CODEX_CURRENT_CHECKOUT_POLL_S:-0.05}"
max_polls="${CODEX_CURRENT_CHECKOUT_MAX_POLLS:-20}"
prompt='Where should the new conversation run?'
option='1. Current checkout'

for ((poll = 0; poll < max_polls; poll += 1)); do
  if content="$(tmux capture-pane -t "$pane" -p 2>/dev/null)"; then
    if [[ "$content" == *"$prompt"* && "$content" == *"$option"* ]]; then
      # Keep the selection and submission separate so the TUI receives them
      # as keystrokes after its chooser has finished painting.
      tmux send-keys -t "$pane" 1
      sleep "$poll_s"
      tmux send-keys -t "$pane" Enter
      exit 0
    fi
  fi
  sleep "$poll_s"
done

exit 1
