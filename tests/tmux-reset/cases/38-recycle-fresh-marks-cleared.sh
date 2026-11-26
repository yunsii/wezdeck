#!/usr/bin/env bash
# recycle --fresh-agent must name the blank session immediately and redirect
# the old transcript to it, including non-Claude agents without a startup id.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

export WEZDECK_ATTENTION_STATE_PATH="$TEST_ROOT/attention.json"
export WEZTERM_ATTENTION_JOURNAL=0
export WEZTERM_ATTENTION_SNAPSHOT=0
export WEZDECK_REPO="$REPO_ROOT"
export AGENT_CTRL_N_FRESH_SH="$TEST_ROOT/fresh-stub.sh"
cat >"$AGENT_CTRL_N_FRESH_SH" <<'EOF'
#!/usr/bin/env bash
printf 'reset_window_in_place\n'
EOF
chmod +x "$AGENT_CTRL_N_FRESH_SH"

mkdir -p "$TEST_ROOT/worktree"
tmux_test_start_session recyclefresh "$TEST_ROOT/worktree" 'exec sleep 300'
pane="$(tmux list-panes -t recyclefresh -F '#{pane_id}' | head -1)"
socket="$(tmux display-message -p -t "$pane" '#{socket_path}')"
tmux set-option -p -t "$pane" @wezterm_pane_role agent-cli:agy
tmux set -g @agent_pane_match '#{&&:#{||:#{m:agent-cli:*,#{@wezterm_pane_role}},#{m:claude*,#{pane_current_command}},#{m:codex*,#{pane_current_command}},#{m:grok*,#{pane_current_command}}},#{!=:1,#{||:#{m:bash*,#{pane_current_command}},#{m:zsh*,#{pane_current_command}},#{m:fish*,#{pane_current_command}}}}}'
cat >"$WEZDECK_ATTENTION_STATE_PATH" <<JSON
{"version":1,"entries":{"old-grok":{"session_id":"old-grok","agent":"grok","tmux_socket":"$socket","tmux_session":"recyclefresh","tmux_pane":"$pane","status":"done","ts":100}},"recent":[]}
JSON

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/runtime/worktree/lib/core-recycle.sh"
wt_tmux_progress() { :; }
runtime_log_info() { :; }
runtime_log_warn() { :; }
out="$(wt_core_recycle_fresh_agent_pane "$TEST_ROOT/worktree")"
new_id="$(sed -n 's/.*session_id=\(pending-[a-f0-9-]*\).*/\1/p' <<<"$out" | head -1)"
[[ "$new_id" == pending-* ]] || {
  printf 'fresh recycle did not return a pending session id:\n%s\n' "$out" >&2
  exit 1
}
python3 - "$WEZDECK_ATTENTION_STATE_PATH" "$new_id" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    doc = json.load(f)
assert not doc['entries'], doc['entries']
old = next(row for row in doc['recent'] if row['session_id'] == 'old-grok')
assert old.get('cleared_to') == sys.argv[2], old
PY

# An active non-agent secondary keeps the original tmux-reset route and does
# not gain an agent placeholder.
mkdir -p "$TEST_ROOT/shell-worktree"
tmux_test_start_session recycleshell "$TEST_ROOT/shell-worktree" 'exec sleep 300'
shell_out="$(wt_core_recycle_fresh_agent_pane "$TEST_ROOT/shell-worktree")"
[[ "$shell_out" != *session_id=* ]] || {
  printf 'non-agent secondary unexpectedly got a session id:\n%s\n' "$shell_out" >&2
  exit 1
}
[[ "$shell_out" == *cold-respawned* ]] || {
  printf 'non-agent secondary did not use the successful reset path:\n%s\n' "$shell_out" >&2
  exit 1
}
printf 'PASS recycle-fresh-marks-cleared\n'
