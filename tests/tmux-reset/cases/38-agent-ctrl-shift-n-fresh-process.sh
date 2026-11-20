#!/usr/bin/env bash
# Ctrl+Shift+n (--fresh): agent panes cold-respawn; non-agent panes no-op.
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

# Create both sessions up front so the server is up before `tmux set -g`
# and so a later kill never drops the harness socket.
SESSION="agentctrlsn-fresh"
SESSION2="agentctrlsn-noop"
tmux new-session -d -s "$SESSION" -c "$TEST_ROOT" /bin/sh -c 'sleep 30'
tmux new-session -d -s "$SESSION2" -c "$TEST_ROOT" /bin/sh -c 'sleep 30'
tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'

# --- agent pane: cold-respawn ---
PANE_ID="$(tmux list-panes -t "$SESSION" -F '#{pane_id}' | head -n 1)"
tmux set-option -p -t "$PANE_ID" @wezterm_pane_role agent-cli:claude

: >"$LOG_FILE"
: >"$TEST_ROOT/fresh.calls"
bash "$CTRL_N" --fresh "$PANE_ID"

if ! grep -q 'Ctrl+Shift+n matched agent pane; cold-respawning fresh' "$LOG_FILE"; then
  printf 'expected cold-respawn log\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'outcome="fresh"' "$LOG_FILE"; then
  printf 'expected outcome=fresh\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'hotkey_id="agent.fresh-process"' "$LOG_FILE" \
  && ! grep -q 'hotkey_id=agent.fresh-process' "$LOG_FILE"; then
  printf 'expected hotkey_id=agent.fresh-process\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'stub-fresh' "$TEST_ROOT/fresh.calls"; then
  printf 'expected stub AGENT_CTRL_N_FRESH_SH call\n' >&2
  exit 1
fi
if grep -q 'staging /new' "$LOG_FILE"; then
  printf 'must not stage /new on --fresh\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

# --- non-agent pane: no-op (no clear) ---
PANE2="$(tmux list-panes -t "$SESSION2" -F '#{pane_id}' | head -n 1)"
tmux set-option -p -t "$PANE2" -u @wezterm_pane_role 2>/dev/null || true

: >"$LOG_FILE"
: >"$TEST_ROOT/fresh.calls"
bash "$CTRL_N" --fresh "$PANE2"

if ! grep -q 'Ctrl+Shift+n non-agent pane; no-op' "$LOG_FILE"; then
  printf 'expected non-agent no-op log\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'outcome="noop_non_agent"' "$LOG_FILE"; then
  printf 'expected outcome=noop_non_agent\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if grep -q 'stub-fresh' "$TEST_ROOT/fresh.calls"; then
  printf 'must not cold-respawn non-agent pane\n' >&2
  exit 1
fi
if grep -q 'injecting clear' "$LOG_FILE"; then
  printf 'must not inject clear on Ctrl+Shift+n non-agent\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'PASS agent-ctrl-shift-n-fresh-process\n'
