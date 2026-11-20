#!/usr/bin/env bash
# Regression: hand-started Grok in a secondary pane shows as python3
# (grok-focus-filter / grok.real). @agent_pane_match is 0 and there is no
# role tag — Ctrl+n must stage /new via process-cmdline detection, not clear.
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

# Keep argv visible in /proc/*/cmdline (do not exec — that would replace
# the command line with plain `sleep` and hide the grok.real marker).
fake_bin="$TEST_ROOT/fake-python"
cat >"$fake_bin" <<'EOF'
#!/bin/sh
sleep 300
EOF
chmod +x "$fake_bin"

SESSION="agentctrln-cmdline"
tmux new-session -d -s "$SESSION" -c "$TEST_ROOT" /bin/bash -c '
  "$1" -- /home/yuns/.grok/bin/grok.real &
  exec sleep 300
' bash "$fake_bin"
tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'
PANE_ID="$(tmux list-panes -t "$SESSION" -F '#{pane_id}' | head -n 1)"
tmux set-option -p -t "$PANE_ID" -u @wezterm_pane_role 2>/dev/null || true
sleep 0.2

: >"$LOG_FILE"
: >"$TEST_ROOT/new.calls"
bash "$CTRL_N" "$PANE_ID"

if ! grep -q 'detected agent via process cmdline; staging /new' "$LOG_FILE"; then
  printf 'expected cmdline-detect staging in %s\n' "$LOG_FILE" >&2
  cat "$LOG_FILE" >&2 || true
  pstree -ap "$(tmux display-message -p -t "$PANE_ID" '#{pane_pid}')" 2>/dev/null >&2 || true
  exit 1
fi
if ! grep -q 'outcome="new_cmdline"' "$LOG_FILE"; then
  printf 'expected outcome=new_cmdline\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'stub-new' "$TEST_ROOT/new.calls"; then
  printf 'expected stub agent-new-into-pane call\n' >&2
  exit 1
fi
if grep -q 'injecting clear' "$LOG_FILE"; then
  printf 'must not inject clear when grok cmdline is present\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'PASS agent-ctrl-n-cmdline-detects-grok\n'
