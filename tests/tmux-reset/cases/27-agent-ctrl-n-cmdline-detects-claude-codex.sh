#!/usr/bin/env bash
# Hand-started Claude / Codex in a secondary pane: no role tag; leaf may be
# sleep/node-shaped. Ctrl+n must detect via process cmdline (same path as Grok).
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

cat >"$TEST_ROOT/agent-new-into-pane.sh" <<EOF
#!/usr/bin/env bash
printf 'stub-new %s\n' "\$1" >>"$TEST_ROOT/new.calls"
exit 0
EOF
chmod +x "$TEST_ROOT/agent-new-into-pane.sh"
export AGENT_NEW_INTO_PANE_SH="$TEST_ROOT/agent-new-into-pane.sh"

# Keep argv visible (no exec).
keeper="$TEST_ROOT/keeper"
cat >"$keeper" <<'EOF'
#!/bin/sh
sleep 300
EOF
chmod +x "$keeper"

run_one() {
  local label="$1"
  local argv_marker="$2"
  local expect_agent="$3"
  local session="agentctrln-${label}"

  tmux kill-session -t "$session" 2>/dev/null || true
  tmux new-session -d -s "$session" -c "$TEST_ROOT" /bin/bash -c '
    "$1" '"$argv_marker"' &
    exec sleep 300
  ' bash "$keeper"
  tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'
  local pane
  pane="$(tmux list-panes -t "$session" -F '#{pane_id}' | head -n 1)"
  tmux set-option -p -t "$pane" -u @wezterm_pane_role 2>/dev/null || true
  sleep 0.2

  : >"$LOG_FILE"
  : >"$TEST_ROOT/new.calls"
  bash "$CTRL_N" "$pane"

  if ! grep -q "detected_agent=\"${expect_agent}\"" "$LOG_FILE"; then
    printf '%s: expected detected_agent=%s\n' "$label" "$expect_agent" >&2
    cat "$LOG_FILE" >&2 || true
    pstree -ap "$(tmux display-message -p -t "$pane" '#{pane_pid}')" 2>/dev/null >&2 || true
    exit 1
  fi
  if ! grep -q 'outcome="new_cmdline"' "$LOG_FILE"; then
    printf '%s: expected outcome=new_cmdline\n' "$label" >&2
    cat "$LOG_FILE" >&2 || true
    exit 1
  fi
  if grep -q 'injecting clear' "$LOG_FILE"; then
    printf '%s: must not inject clear\n' "$label" >&2
    exit 1
  fi
  tmux kill-session -t "$session" 2>/dev/null || true
}

# Claude: argv looks like a PATH binary named claude.
run_one "claude" "-- /home/yuns/.local/bin/claude" "claude"
# Codex: node-style module path (common when leaf is node / keeper).
run_one "codex" "-- /x/node_modules/@openai/codex/bin/codex.js" "codex"

printf 'PASS agent-ctrl-n-cmdline-detects-claude-codex\n'
