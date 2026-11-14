#!/usr/bin/env bash
# A floating pane (tmux 3.8 new-pane / Ctrl+drag) whose process exits must
# close, not be respawned in place like a tiled pane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

ROOT="$TEST_ROOT/floating-pane-exit"
mkdir -p "$ROOT"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s floatexit -c "$ROOT" /bin/sh -lc 'exec sleep 300')"

tmux set-option -g remain-on-exit on
tmux set-hook -g pane-died "run-shell -b \"bash $REPO_ROOT/scripts/runtime/pane-exit-keep.sh #{q:socket_path} #{q:hook_pane} #{q:pane_current_path} >/dev/null 2>&1\""

TILED_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
FLOAT_PANE="$(tmux new-pane -d -P -F '#{pane_id}' -t "$WINDOW_ID" -c "$ROOT" /bin/sleep 300)"
floating="$(tmux display-message -p -t "$FLOAT_PANE" '#{pane_floating_flag}')"
tmux_test_assert_eq "1" "$floating" "new-pane should create a floating pane"

kill -INT "$(tmux display-message -p -t "$FLOAT_PANE" '#{pane_pid}')"
gone=""
for _ in $(seq 1 40); do
  if ! tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | grep -Fxq "$FLOAT_PANE"; then
    gone=1
    break
  fi
  sleep 0.05
done
if [[ -z "$gone" ]]; then
  printf 'floating pane %s survived exit (dead=%s cmd=%s)\n' "$FLOAT_PANE" \
    "$(tmux display-message -p -t "$FLOAT_PANE" '#{pane_dead}')" \
    "$(tmux display-message -p -t "$FLOAT_PANE" '#{pane_current_command}')" >&2
  exit 1
fi

pane_ids="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}')"
tmux_test_assert_contains_line "$TILED_PANE" "$pane_ids" \
  "closing a floating pane must not touch the tiled pane"

printf 'PASS floating-pane-exit-closes\n'
