#!/usr/bin/env bash
# Codex agent panes use the same cold-respawn Ctrl+n path (no /new chooser).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CTRL_N="$REAL_REPO/scripts/runtime/agent-ctrl-n.sh"
LOG_FILE="$TEST_ROOT/runtime.log"
export WEZTERM_RUNTIME_LOG_FILE="$LOG_FILE"
export WEZTERM_RUNTIME_LOG_ENABLED=1
export WEZTERM_RUNTIME_LOG_LEVEL=info
export WEZTERM_RUNTIME_LOG_CATEGORIES=""

cat >"$TEST_ROOT/agent-fresh.sh" <<'EOF'
#!/usr/bin/env bash
printf 'stub-fresh %s\n' "$*" >>"${TEST_ROOT:?}/fresh.calls"
EOF
chmod +x "$TEST_ROOT/agent-fresh.sh"
export AGENT_CTRL_N_FRESH_SH="$TEST_ROOT/agent-fresh.sh"
export TEST_ROOT

SESSION="agentctrln-codex-fresh"
tmux new-session -d -s "$SESSION" -c "$TEST_ROOT" \
  /bin/sh -c 'sleep 30'
tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'
PANE_ID="$(tmux list-panes -t "$SESSION" -F '#{pane_id}' | head -n 1)"
tmux set-option -p -t "$PANE_ID" @wezterm_pane_role agent-cli:codex

: >"$LOG_FILE"
: >"$TEST_ROOT/fresh.calls"
bash "$CTRL_N" "$PANE_ID"

if ! grep -q 'Ctrl+n matched agent pane; cold-respawning fresh' "$LOG_FILE"; then
  printf 'expected cold-respawn log\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'outcome="fresh"' "$LOG_FILE"; then
  printf 'expected outcome=fresh\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'stub-fresh' "$TEST_ROOT/fresh.calls"; then
  printf 'expected stub AGENT_CTRL_N_FRESH_SH call\n' >&2
  exit 1
fi
if grep -q 'Codex new conversation selected' "$LOG_FILE"; then
  printf 'must not run Codex /new chooser after cold-respawn change\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'PASS agent-ctrl-n-codex-fresh-respawn\n'
