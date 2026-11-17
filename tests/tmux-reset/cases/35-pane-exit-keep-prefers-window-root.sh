#!/usr/bin/env bash
# pane-died often expands #{pane_current_path} to empty. pane-exit-keep
# must respawn the login shell under @wezterm_window_root (or a sibling
# pane path), not $HOME — otherwise F5 poisons the managed window root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT
export MANAGED_AGENT_PROFILE=noresume

ROOT="$TEST_ROOT/pane-exit-keep-root"
mkdir -p "$ROOT"
SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sleep 300)"
tmux rename-window -t "$WINDOW_ID" pane-keep-root

# remain-on-exit parks the dead pane; the live pane-died hook is left off
# so this case drives pane-exit-keep with an explicit empty cwd (the
# #{pane_current_path} expansion failure), without racing an auto-hook.
tmux set-option -g remain-on-exit on
tmux set-hook -gu pane-died

tmux_test_set_session_metadata "$SESSION_NAME" work managed
tmux_test_set_window_metadata "$WINDOW_ID" managed_primary "$ROOT" pane-keep-root \
  "/bin/sleep 300" managed_two_pane
tmux_worktree_ensure_window_panes "$WINDOW_ID" "$ROOT"

PRIMARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
SECONDARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | tail -n 1)"

# Simulate the live failure: agent dies and the hook receives an empty cwd
# (#{pane_current_path} on a dead pane). Directly invoke the keep script
# with cwd="" while the pane is marked dead via SIGKILL of a short sleep.
tmux respawn-pane -k -t "$PRIMARY_PANE" -c "$ROOT" /bin/sleep 300
sleep 0.1
agent_pid="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_pid}')"
kill -KILL "$agent_pid" 2>/dev/null || true

# Wait until remain-on-exit parks the pane as dead.
dead=""
for _ in $(seq 1 40); do
  dead="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_dead}' 2>/dev/null || true)"
  [[ "$dead" == "1" ]] && break
  sleep 0.05
done
tmux_test_assert_eq "1" "$dead" "primary pane must be dead before empty-cwd keep"

socket_path="$(tmux display-message -p -t "$PRIMARY_PANE" '#{socket_path}')"
: > "$TEST_LOG"
# Empty third arg is the bug shape from #{pane_current_path} on pane-died.
bash "$REPO_ROOT/scripts/runtime/pane-exit-keep.sh" "$socket_path" "$PRIMARY_PANE" ""

kept_cwd=""
for _ in $(seq 1 40); do
  dead="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_dead}' 2>/dev/null || true)"
  cmd="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_current_command}' 2>/dev/null || true)"
  cwd="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_current_path}' 2>/dev/null || true)"
  if [[ "$dead" == "0" && -n "$cmd" && -n "$cwd" ]]; then
    kept_cwd="$cwd"
    break
  fi
  sleep 0.05
done

if [[ -z "$kept_cwd" ]]; then
  printf 'pane-exit-keep did not respawn after empty cwd\n' >&2
  exit 1
fi

tmux_test_assert_eq "$ROOT" "$kept_cwd" \
  "empty pane-died cwd must respawn under @wezterm_window_root, not \$HOME"
tmux_test_assert_eq "$ROOT" "$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_current_path}')" \
  "secondary pane must stay on the worktree root"

case "$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_current_command}')" in
  bash|zsh|sh) ;;
  *)
    printf 'expected login shell after keep, got %s\n' \
      "$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_current_command}')" >&2
    exit 1
    ;;
esac

# Log must record a non-HOME heal source (runtime.log quotes field values).
if ! grep -E 'cwd_source="(window_root|sibling_pane)"' "$TEST_LOG" >/dev/null; then
  printf 'expected cwd_source=window_root|sibling_pane in runtime log\n' >&2
  grep 'pane exit keep' "$TEST_LOG" >&2 || true
  exit 1
fi
if grep -E 'cwd_source="home_fallback"' "$TEST_LOG" >/dev/null; then
  printf 'must not fall back to HOME when window_root/sibling are available\n' >&2
  grep 'pane exit keep' "$TEST_LOG" >&2 || true
  exit 1
fi

# Single-pane window: no sibling path. Empty cwd must still use window_root.
SINGLE_ROOT="$TEST_ROOT/pane-exit-keep-single"
mkdir -p "$SINGLE_ROOT"
SINGLE_SESSION="$(tmux_worktree_session_name_for_path work "$SINGLE_ROOT")"
SINGLE_WINDOW="$(tmux new-session -d -P -F '#{window_id}' -s "$SINGLE_SESSION" -c "$SINGLE_ROOT" /bin/sleep 300)"
tmux rename-window -t "$SINGLE_WINDOW" pane-keep-single
tmux_test_set_session_metadata "$SINGLE_SESSION" work managed
tmux_test_set_window_metadata "$SINGLE_WINDOW" managed_primary "$SINGLE_ROOT" pane-keep-single \
  "/bin/sleep 300" single
SINGLE_PANE="$(tmux list-panes -t "$SINGLE_WINDOW" -F '#{pane_id}' | head -n 1)"
tmux respawn-pane -k -t "$SINGLE_PANE" -c "$SINGLE_ROOT" /bin/sleep 300
sleep 0.1
kill -KILL "$(tmux display-message -p -t "$SINGLE_PANE" '#{pane_pid}')" 2>/dev/null || true
for _ in $(seq 1 40); do
  [[ "$(tmux display-message -p -t "$SINGLE_PANE" '#{pane_dead}' 2>/dev/null || true)" == "1" ]] && break
  sleep 0.05
done
socket_path="$(tmux display-message -p -t "$SINGLE_PANE" '#{socket_path}')"
: > "$TEST_LOG"
bash "$REPO_ROOT/scripts/runtime/pane-exit-keep.sh" "$socket_path" "$SINGLE_PANE" ""
single_cwd=""
for _ in $(seq 1 40); do
  dead="$(tmux display-message -p -t "$SINGLE_PANE" '#{pane_dead}' 2>/dev/null || true)"
  cwd="$(tmux display-message -p -t "$SINGLE_PANE" '#{pane_current_path}' 2>/dev/null || true)"
  if [[ "$dead" == "0" && -n "$cwd" ]]; then
    single_cwd="$cwd"
    break
  fi
  sleep 0.05
done
tmux_test_assert_eq "$SINGLE_ROOT" "$single_cwd" \
  "single-pane empty cwd must respawn under @wezterm_window_root"
if ! grep -E 'cwd_source="window_root"' "$TEST_LOG" >/dev/null; then
  printf 'single-pane keep must log cwd_source=window_root\n' >&2
  grep 'pane exit keep' "$TEST_LOG" >&2 || true
  exit 1
fi

printf 'PASS pane-exit-keep-prefers-window-root\n'
