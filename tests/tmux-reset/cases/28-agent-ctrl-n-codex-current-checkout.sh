#!/usr/bin/env bash
# Codex's /new chooser should select Current checkout after the pane paints it.
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
export TEST_ROOT
export CODEX_CURRENT_CHECKOUT_POLL_S=0.01
export CODEX_CURRENT_CHECKOUT_MAX_POLLS=5

cat >"$TEST_ROOT/agent-new-into-pane.sh" <<'EOF'
#!/usr/bin/env bash
printf 'stub-new %s\n' "$1" >>"$TEST_ROOT/new.calls"
EOF
chmod +x "$TEST_ROOT/agent-new-into-pane.sh"
export AGENT_NEW_INTO_PANE_SH="$TEST_ROOT/agent-new-into-pane.sh"

SESSION="agentctrln-codex-current"
tmux new-session -d -s "$SESSION" -c "$TEST_ROOT" \
  /bin/sh -c 'printf "Where should the new conversation run?\n1. Current checkout\n2. New worktree\n"; sleep 30'
tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'
PANE_ID="$(tmux list-panes -t "$SESSION" -F '#{pane_id}' | head -n 1)"
tmux set-option -p -t "$PANE_ID" @wezterm_pane_role agent-cli:codex

: >"$LOG_FILE"
bash "$CTRL_N" "$PANE_ID"

if ! grep -q 'Codex new conversation selected current checkout' "$LOG_FILE"; then
  printf 'expected Codex current-checkout selection log\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'selection="current_checkout"' "$LOG_FILE"; then
  printf 'expected selection=current_checkout\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'outcome="new"' "$LOG_FILE"; then
  printf 'expected outcome=new\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'PASS agent-ctrl-n-codex-current-checkout\n'
