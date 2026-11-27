#!/usr/bin/env bash
# Ctrl+n `/new` on an Agy pane unpins typed resume, archives the old entry,
# and marks cleared_to a temporary pending-* id immediately (Agy only fires
# SessionStart when the first prompt is sent). Also verifies
# agent_session_resolve_for_pane never resurrects a cleared row or pending-* id.
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

SESSION="ctrlnagy"
tmux new-session -d -s "$SESSION" -n "dev-agy" -c "$WT" /bin/sh -c 'sleep 300'
tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}},#{m:agy*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'
WINDOW_ID="$(tmux list-windows -t "$SESSION" -F '#{window_id}' | head -n 1)"
PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
SOCKET_PATH="$(tmux display-message -p -t "$PANE_ID" '#{socket_path}')"

tmux set-option -p -t "$PANE_ID" @wezterm_pane_role "agent-cli:agy"
tmux set-window-option -t "$WINDOW_ID" -q @wezterm_window_primary_pane "$PANE_ID"
tmux set-option -p -t "$PANE_ID" -q @wezterm_agent_session_id "old-agy-sid"
agent_session_pin_put "$WT" primary "old-agy-sid" agy

cat > "$ATT_PATH" <<JSON
{
  "version": 1,
  "entries": {
    "old-agy-sid": {
      "session_id": "old-agy-sid",
      "tmux_socket": "$SOCKET_PATH",
      "tmux_session": "$SESSION",
      "tmux_pane": "$PANE_ID",
      "tmux_window_name": "dev-agy",
      "agent_name": "agy",
      "status": "done",
      "ts": 100
    }
  },
  "recent": []
}
JSON

export AGENT_NEW_INTO_PANE_SH="$TEST_ROOT/stub-new.sh"
cat > "$AGENT_NEW_INTO_PANE_SH" <<EOF
#!/usr/bin/env bash
printf 'stub-new %s\n' "\${1:-}" >>"$TEST_ROOT/new.calls"
EOF
chmod +x "$AGENT_NEW_INTO_PANE_SH"

bash "$CTRL_N" "$PANE_ID"

if jq -e '.entries["old-agy-sid"] != null' "$ATT_PATH" >/dev/null 2>&1; then
  printf 'old-agy-sid still live in entries after Ctrl+n\n' >&2
  cat "$ATT_PATH" >&2
  exit 1
fi

cleared_to="$(jq -r '.recent[] | select(.session_id == "old-agy-sid") | .cleared_to // ""' "$ATT_PATH")"
if [[ ! "$cleared_to" =~ ^pending-[0-9a-f-]+$ ]]; then
  printf 'expected cleared_to=pending-<uuid> for old-agy-sid, got %q\n' "$cleared_to" >&2
  cat "$ATT_PATH" >&2
  exit 1
fi

if agent_session_id_usable "$cleared_to"; then
  printf 'pending-* id must not be treated as a usable CLI resume id\n' >&2
  exit 1
fi

# Even with matching tmux_window_name="dev-agy", resolve_for_pane must not
# resurrect old-agy-sid or return the synthetic pending-* placeholder.
resolved="$(agent_session_resolve_for_pane "$PANE_ID" || true)"
if [[ -n "$resolved" ]]; then
  printf 'resolve_for_pane must stay empty while pending, got %q\n' "$resolved" >&2
  exit 1
fi

printf 'PASS agent-ctrl-n-agy-pending-cleared\n'
