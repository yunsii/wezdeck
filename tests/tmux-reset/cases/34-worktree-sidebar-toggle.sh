#!/usr/bin/env bash
# Floating worktree sidebar toggle (tmux 3.8+ pilot).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

export PATH="${HOME}/.local/bin:${PATH}"
ver="$(tmux -V 2>/dev/null | awk '{print $2}')"
case "$ver" in
  3.[89]*|[4-9].*|3.[1-9][0-9]*) ;;
  *)
    printf 'SKIP worktree-sidebar-toggle (need tmux 3.8+, have %s)\n' "$ver"
    exit 0
    ;;
esac

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ROOT="$TEST_ROOT/repo"
mkdir -p "$ROOT"
git -C "$ROOT" init -b master >/dev/null 2>&1
git -C "$ROOT" config user.email 't@t'
git -C "$ROOT" config user.name 't'
printf 'x\n' > "$ROOT/f"
git -C "$ROOT" add f
git -C "$ROOT" commit -m init >/dev/null

SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sh -lc 'exec sleep 300')"
tmux rename-window -t "$WINDOW_ID" primary

bash "$REAL_REPO/scripts/runtime/worktree-sidebar.sh" open \
  "$SESSION_NAME" "$WINDOW_ID" "$ROOT"
sleep 0.3
pane="$(tmux list-panes -t "$SESSION_NAME" -F '#{pane_id}|#{@wezterm_pane_role}|#{pane_floating_flag}' \
  | awk -F'|' '$2=="worktree-sidebar"{print; exit}')"
[[ -n "$pane" ]] || {
  printf 'sidebar pane missing after open\n' >&2
  tmux list-panes -t "$SESSION_NAME" -F '#{pane_id}|#{@wezterm_pane_role}|#{pane_floating_flag}' >&2
  exit 1
}
floating="${pane##*|}"
[[ "$floating" == "1" ]] || {
  printf 'expected floating=1, got %s\n' "$floating" >&2
  exit 1
}

bash "$REAL_REPO/scripts/runtime/worktree-sidebar.sh" toggle \
  "$SESSION_NAME" "$WINDOW_ID" "$ROOT"
sleep 0.2
left="$(tmux list-panes -t "$SESSION_NAME" -F '#{@wezterm_pane_role}' | grep -c worktree-sidebar || true)"
[[ "$left" == "0" ]] || {
  printf 'sidebar still present after toggle close\n' >&2
  exit 1
}

printf 'PASS worktree-sidebar-toggle\n'
