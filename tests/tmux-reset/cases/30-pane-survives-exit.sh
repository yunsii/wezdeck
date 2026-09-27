#!/usr/bin/env bash
# A pane process that exits on its own must not delete the pane.
# Covers the two live failures:
#   - F5 on a secondary pane whose #{pane_start_command} is a quoted
#     display string ("/usr/bin/zsh -il") — passing that string back to
#     respawn-pane looks up a missing binary and the pane dies.
#   - Ctrl+C / quit of the process that owns the pane (agent exec'd into
#     the pty) — remain-on-exit + pane-died respawns a login shell.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT
export MANAGED_AGENT_PROFILE=noresume

ROOT="$TEST_ROOT/pane-survives-exit"
mkdir -p "$ROOT"
SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sh -lc 'exec sleep 300')"
tmux rename-window -t "$WINDOW_ID" pane-keep

# Live server loads hooks from the synced runtime copy. This isolated
# server has to install the same contract explicitly.
tmux set-option -g remain-on-exit on
tmux set-hook -g pane-died "run-shell -b \"bash $REPO_ROOT/scripts/runtime/pane-exit-keep.sh #{q:socket_path} #{q:hook_pane} #{q:pane_current_path} >/dev/null 2>&1\""

tmux_test_set_session_metadata "$SESSION_NAME" work managed
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/runtime/managed-shell-lib.sh"
# Quoted display form is what #{pane_start_command} returns after a real
# split ("/usr/bin/zsh -il"). The old refresh path fed that string straight
# back to respawn-pane, which looked up a binary that does not exist.
LOGIN_SHELL="$(resolve_login_shell)"
QUOTED_START="$(printf '%q -il' "$LOGIN_SHELL")"
tmux_test_set_window_metadata "$WINDOW_ID" managed_primary "$ROOT" pane-keep "\"$QUOTED_START\"" managed_two_pane
tmux_worktree_ensure_window_panes "$WINDOW_ID" "$ROOT"

PRIMARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
SECONDARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | tail -n 1)"

tmux select-pane -t "$SECONDARY_PANE"
bash "$SCRIPT_DIR/../../../scripts/runtime/session-refresh-current-window.sh" \
  "$SESSION_NAME" "$WINDOW_ID" "$ROOT"
sleep 0.3

pane_ids="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}')"
tmux_test_assert_contains_line "$SECONDARY_PANE" "$pane_ids" \
  "F5 on a secondary pane with a quoted start command must keep the pane"
tmux_test_assert_contains_line "$PRIMARY_PANE" "$pane_ids" \
  "secondary F5 must not destroy the primary pane"
secondary_dead="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_dead}')"
tmux_test_assert_eq "0" "$secondary_dead" \
  "secondary pane must be alive after F5, not stuck dead"
secondary_cmd="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_current_command}')"
case "$secondary_cmd" in
  bash|zsh|sh) ;;
  *)
    printf 'secondary F5 must land on a login shell\nactual: %s\n' "$secondary_cmd" >&2
    exit 1
    ;;
esac

# Process that owns the pty exits via SIGINT — the agent Ctrl+C shape
# (launcher exec's the CLI, so the pane pid is the agent itself).
tmux respawn-pane -k -t "$PRIMARY_PANE" -c "$ROOT" /bin/sleep 300
sleep 0.2
agent_pid="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_pid}')"
kill -INT "$agent_pid"
kept=""
for _ in $(seq 1 40); do
  if ! tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' 2>/dev/null | grep -Fxq "$PRIMARY_PANE"; then
    printf 'primary pane %s was destroyed after SIGINT\n' "$PRIMARY_PANE" >&2
    exit 1
  fi
  current="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_current_command}' 2>/dev/null || true)"
  dead="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_dead}' 2>/dev/null || true)"
  if [[ "$dead" == "0" && "$current" != "sleep" && -n "$current" ]]; then
    kept="$current"
    break
  fi
  sleep 0.05
done
if [[ -z "$kept" ]]; then
  printf 'primary pane did not respawn a shell after SIGINT\ncurrent=%s dead=%s\n' \
    "${current:-}" "${dead:-}" >&2
  exit 1
fi

pane_count="$(tmux list-panes -t "$WINDOW_ID" | wc -l | tr -d ' ')"
tmux_test_assert_eq "2" "$pane_count" "window should still have both panes after SIGINT"

printf 'PASS pane-survives-exit\n'
