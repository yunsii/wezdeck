#!/usr/bin/env bash
# After Ctrl+n stages /new, typed-resume sources for that pane must be
# cleared so a subsequent F5 cannot resurrect the discarded conversation
# via pane option / durable pin / window pin / attention.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CTRL_N="$REAL_REPO/scripts/runtime/agent-ctrl-n.sh"
# shellcheck disable=SC1091
source "$REAL_REPO/scripts/runtime/agent-session-resolve.sh"

LOG_FILE="$TEST_ROOT/runtime.log"
export WEZTERM_RUNTIME_LOG_FILE="$LOG_FILE"
export WEZTERM_RUNTIME_LOG_ENABLED=1
export WEZTERM_RUNTIME_LOG_LEVEL=info
export WEZTERM_RUNTIME_LOG_CATEGORIES=""

PINS_PATH="$TEST_ROOT/agent-session-pins.json"
export WEZDECK_AGENT_SESSION_PINS_PATH="$PINS_PATH"
ATT_PATH="$TEST_ROOT/attention.json"
export WEZDECK_ATTENTION_STATE_PATH="$ATT_PATH"

WT="$TEST_ROOT/worktree"
mkdir -p "$WT"

SESSION="ctrlnpin"
tmux new-session -d -s "$SESSION" -c "$WT" /bin/sh -c 'sleep 300'
tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'
WINDOW_ID="$(tmux list-windows -t "$SESSION" -F '#{window_id}' | head -n 1)"
PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
SOCKET_PATH="$(tmux display-message -p -t "$PANE_ID" '#{socket_path}')"

tmux set-option -p -t "$PANE_ID" @wezterm_pane_role "agent-cli:claude"
tmux set-window-option -t "$WINDOW_ID" -q @wezterm_window_primary_pane "$PANE_ID"
tmux set-option -p -t "$PANE_ID" -q @wezterm_agent_session_id "old-sid-before-new"
tmux set-window-option -t "$WINDOW_ID" -q @wezterm_primary_agent_session_id "old-sid-before-new"
agent_session_pin_put "$WT" primary "old-sid-before-new" claude

cat > "$ATT_PATH" <<JSON
{
  "version": 1,
  "entries": {
    "old-sid-before-new": {
      "session_id": "old-sid-before-new",
      "tmux_socket": "$SOCKET_PATH",
      "tmux_session": "$SESSION",
      "tmux_pane": "$PANE_ID",
      "tmux_window_name": "0",
      "status": "running",
      "ts": 100
    }
  },
  "recent": []
}
JSON

# Stub /new injector — we only care that staging triggers unpin.
# Bake absolute paths into the stub; the child bash does not inherit
# unexported TEST_ROOT from this script.
export AGENT_NEW_INTO_PANE_SH="$TEST_ROOT/stub-new.sh"
cat > "$AGENT_NEW_INTO_PANE_SH" <<EOF
#!/usr/bin/env bash
printf 'stub-new %s\n' "\${1:-}" >>"$TEST_ROOT/new.calls"
EOF
chmod +x "$AGENT_NEW_INTO_PANE_SH"
: >"$TEST_ROOT/new.calls"

bash "$CTRL_N" "$PANE_ID"

pane_sid="$(tmux show-options -p -t "$PANE_ID" -v -q @wezterm_agent_session_id 2>/dev/null || true)"
[[ -z "$pane_sid" ]] || {
  printf 'pane option still set after /new: %s\n' "$pane_sid" >&2
  exit 1
}

win_sid="$(tmux show-window-options -t "$WINDOW_ID" -v -q @wezterm_primary_agent_session_id 2>/dev/null || true)"
[[ -z "$win_sid" ]] || {
  printf 'window pin still set after /new: %s\n' "$win_sid" >&2
  exit 1
}

pin="$(agent_session_pin_get "$WT" primary || true)"
[[ -z "$pin" ]] || {
  printf 'durable pin still set after /new: %s\n' "$pin" >&2
  exit 1
}

resolved="$(agent_session_resolve_for_pane "$PANE_ID" || true)"
[[ -z "$resolved" ]] || {
  printf 'resolve still returns discarded id after /new: %s\n' "$resolved" >&2
  exit 1
}

discarded="$(tmux show-options -p -t "$PANE_ID" -v -q @wezterm_agent_discarded_session_id 2>/dev/null || true)"
[[ "$discarded" == "old-sid-before-new" ]] || {
  printf 'expected discarded_session_id=old-sid-before-new, got=%s\n' "$discarded" >&2
  exit 1
}

if ! grep -Fq 'Ctrl+n invalidated typed resume after /new' "$LOG_FILE"; then
  printf 'expected invalidate log in %s\n' "$LOG_FILE" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -Eq 'prev_session_id="?old-sid-before-new"?' "$LOG_FILE"; then
  printf 'expected prev_session_id in invalidate log\n' >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi
if ! grep -Fq 'stub-new' "$TEST_ROOT/new.calls"; then
  printf 'expected stub /new injector to run\n' >&2
  exit 1
fi

# After the user starts chatting, hooks pin the live (new) id — F5 follows it.
agent_session_pin_pane "$PANE_ID" "new-sid-after-hooks" claude "$WT"
pane_sid="$(tmux show-options -p -t "$PANE_ID" -v -q @wezterm_agent_session_id 2>/dev/null || true)"
[[ "$pane_sid" == "new-sid-after-hooks" ]] || {
  printf 'expected pin to new-sid-after-hooks, got=%s\n' "$pane_sid" >&2
  exit 1
}
resolved="$(agent_session_resolve_for_pane "$PANE_ID" || true)"
[[ "$resolved" == "new-sid-after-hooks" ]] || {
  printf 'resolve should follow current new session, got=%s\n' "$resolved" >&2
  exit 1
}

printf 'PASS agent-ctrl-n-clears-session-pins\n'
