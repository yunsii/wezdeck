#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REFRESH_SCRIPT="$REPO_ROOT/scripts/runtime/tmux-copy-mode-auto-refresh.sh"

command -v tmux >/dev/null 2>&1 || {
  printf 'missing required command: tmux\n' >&2
  exit 1
}

socket_path="/tmp/wezterm-copy-mode-auto-refresh.$$.$RANDOM.sock"
refresh_pid=""

cleanup() {
  if [[ -n "$refresh_pid" ]]; then
    kill "$refresh_pid" >/dev/null 2>&1 || true
    wait "$refresh_pid" >/dev/null 2>&1 || true
  fi
  tmux -S "$socket_path" kill-server >/dev/null 2>&1 || true
  rm -f "$socket_path"
}
trap cleanup EXIT

tmux -S "$socket_path" new-session -d -s s 'bash -lc '"'"'i=1; while [ "$i" -le 80 ]; do printf "line-%03d abcdefghijklmnopqrstuvwxyz\n" "$i"; i=$((i + 1)); sleep 0.02; done; sleep 30'"'"''
sleep 0.2

pane_id="$(tmux -S "$socket_path" display-message -p -t s:0.0 '#{pane_id}')"
tmux -S "$socket_path" set-option -gq @copy_mode_auto_refresh 1
tmux -S "$socket_path" copy-mode -t "$pane_id"
tmux -S "$socket_path" send-keys -t "$pane_id" -X start-of-line
tmux -S "$socket_path" send-keys -t "$pane_id" -X begin-selection
tmux -S "$socket_path" send-keys -t "$pane_id" -X cursor-right
tmux -S "$socket_path" send-keys -t "$pane_id" -X cursor-right
tmux -S "$socket_path" send-keys -t "$pane_id" -X cursor-right
tmux -S "$socket_path" send-keys -t "$pane_id" -X stop-selection

before="$(tmux -S "$socket_path" display-message -p -t "$pane_id" '#{selection_present}')"
if [[ "$before" != "1" ]]; then
  printf 'test setup failed: expected selection_present=1, got %s\n' "$before" >&2
  exit 1
fi

bash "$REFRESH_SCRIPT" "$socket_path" "$pane_id" 100 &
refresh_pid="$!"
sleep 0.35

after="$(tmux -S "$socket_path" display-message -p -t "$pane_id" '#{selection_present}')"
if [[ "$after" != "1" ]]; then
  printf 'auto-refresh should not clear active selection; got selection_present=%s\n' "$after" >&2
  exit 1
fi

if ! kill -0 "$refresh_pid" >/dev/null 2>&1; then
  printf 'auto-refresh loop exited while copy-mode was active\n' >&2
  exit 1
fi

tmux -S "$socket_path" send-keys -t "$pane_id" -X cancel
for _ in $(seq 1 30); do
  if ! kill -0 "$refresh_pid" >/dev/null 2>&1; then
    refresh_pid=""
    printf 'PASS tmux-copy-mode-auto-refresh\n'
    exit 0
  fi
  sleep 0.05
done

printf 'auto-refresh loop did not exit after copy-mode was cancelled\n' >&2
exit 1
