#!/usr/bin/env bash
# Regression: Ctrl+n on a resume-wrapper pane missing @wezterm_pane_role
# must leave a greppable warn in runtime.log (the silent pass-through that
# made the dig-investigation bug undiagnosable from logs alone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree/metadata.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CTRL_N="$REAL_REPO/scripts/runtime/agent-ctrl-n.sh"
LOG_FILE="$TEST_ROOT/runtime.log"
export WEZTERM_RUNTIME_LOG_FILE="$LOG_FILE"
export WEZTERM_RUNTIME_LOG_ENABLED=1
export WEZTERM_RUNTIME_LOG_LEVEL=info
export WEZTERM_RUNTIME_LOG_CATEGORIES=""

SESSION="agentctrln"
# Keep leaf as `sh` (no exec) so the suspected-miss heuristic — resume
# wrapper leaf sh/node + managed primary_command + empty role — fires.
tmux new-session -d -s "$SESSION" -c "$TEST_ROOT" /bin/sh -c 'sleep 300'
# Isolated test server does not load repo tmux.conf; install the same
# @agent_pane_match predicate Ctrl+n uses in production.
tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'
WINDOW_ID="$(tmux list-windows -t "$SESSION" -F '#{window_id}' | head -n 1)"
PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"

# Managed primary metadata + sh leaf + no role tag → suspected miss.
tmux set-window-option -t "$WINDOW_ID" -q @wezterm_window_primary_command \
  "$(tmux_worktree_metadata_encode_primary_command "$REAL_REPO/scripts/runtime/agent-launcher.sh claude")"
tmux set-option -p -t "$PANE_ID" -u @wezterm_pane_role 2>/dev/null || true

# Sanity: leaf must be sh for the warn heuristic (sleep-as-leaf would skip it).
leaf="$(tmux display-message -p -t "$PANE_ID" '#{pane_current_command}')"
if [[ "$leaf" != "sh" && "$leaf" != "sh"* ]]; then
  printf 'fixture leaf is %s, expected sh (avoid exec in the sleep command)\n' "$leaf" >&2
  exit 1
fi

bash "$CTRL_N" "$PANE_ID"

if ! grep -q 'Ctrl+n pass-through on suspected agent pane' "$LOG_FILE"; then
  printf 'expected suspected-miss warn in %s\n' "$LOG_FILE" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'pane_role=""' "$LOG_FILE" && ! grep -q 'pane_role=' "$LOG_FILE"; then
  printf 'expected pane_role field in log\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

# Tag the pane → next press should stage /new (info), not warn.
: > "$LOG_FILE"
tmux set-option -p -t "$PANE_ID" @wezterm_pane_role "agent-cli:claude"
bash "$CTRL_N" "$PANE_ID"

if ! grep -q 'Ctrl+n matched agent pane; staging /new' "$LOG_FILE"; then
  printf 'expected match/staging info in %s\n' "$LOG_FILE" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if grep -q 'suspected agent pane' "$LOG_FILE"; then
  printf 'did not expect suspected-miss warn after tagging\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'PASS agent-ctrl-n-logs-suspected-miss\n'
