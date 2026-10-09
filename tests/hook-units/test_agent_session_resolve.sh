#!/usr/bin/env bash
# Unit tests for scripts/runtime/agent-session-resolve.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/wezterm-agent-session-resolve.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/runtime/agent-session-resolve.sh"

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

# --- usable id ---
agent_session_id_usable "01a0ebb6-3ce7-7482-af90-05fe7e63dc28" || fail "uuid should be usable"
agent_session_id_usable "pane:12" && fail "pane: fallback must be rejected"
agent_session_id_usable "" && fail "empty must be rejected"
pass "agent_session_id_usable filters pane: and empty"

# --- attention lookup ---
ATT_DIR="$TEST_ROOT/state/agent-attention"
mkdir -p "$ATT_DIR"
ATT_PATH="$ATT_DIR/attention.json"
cat > "$ATT_PATH" <<'JSON'
{
  "version": 1,
  "entries": {
    "live-sid-aaa": {
      "session_id": "live-sid-aaa",
      "tmux_socket": "/tmp/tmux-1000/default",
      "tmux_session": "wezterm_config_demo",
      "tmux_pane": "%2",
      "tmux_window_name": "dev-infra",
      "status": "waiting",
      "ts": 100
    },
    "pane:99": {
      "session_id": "pane:99",
      "tmux_socket": "/tmp/tmux-1000/default",
      "tmux_session": "wezterm_config_demo",
      "tmux_pane": "%9",
      "tmux_window_name": "dev-infra",
      "status": "running",
      "ts": 200
    },
    "live-sid-no-wname": {
      "session_id": "live-sid-no-wname",
      "tmux_socket": "/tmp/tmux-1000/default",
      "tmux_session": "wezterm_config_demo",
      "tmux_pane": "%3",
      "status": "running",
      "ts": 150
    }
  },
  "recent": [
    {
      "session_id": "recent-sid-bbb",
      "tmux_socket": "/tmp/tmux-1000/default",
      "tmux_session": "wezterm_config_demo",
      "tmux_pane": "%7",
      "tmux_window_name": "dev-investigation",
      "archived_ts": 300
    },
    {
      "session_id": "recent-sid-old",
      "tmux_socket": "/tmp/tmux-1000/default",
      "tmux_session": "wezterm_config_demo",
      "tmux_pane": "%7",
      "tmux_window_name": "dev-investigation",
      "archived_ts": 100
    }
  ]
}
JSON

export WEZDECK_ATTENTION_STATE_PATH="$ATT_PATH"

got="$(agent_session_resolve_from_attention \
  "/tmp/tmux-1000/default" "wezterm_config_demo" "%2")"
[[ "$got" == "live-sid-aaa" ]] || fail "live entry expected, got=$got"
pass "resolve live entry by pane"

got="$(agent_session_resolve_from_attention \
  "/tmp/tmux-1000/default" "wezterm_config_demo" "%7")"
[[ "$got" == "recent-sid-bbb" ]] || fail "newest recent expected, got=$got"
pass "resolve newest recent tombstone"

got="$(agent_session_resolve_from_attention \
  "/tmp/tmux-1000/default" "wezterm_config_demo" "%9")"
[[ -z "$got" ]] || fail "pane: fallback id must not resolve, got=$got"
pass "reject pane: attention keys"

got="$(agent_session_resolve_from_attention \
  "/tmp/tmux-1000/default" "wezterm_config_demo" "%404")"
[[ -z "$got" ]] || fail "missing pane must be empty, got=$got"
pass "missing pane returns empty"

# Recycled pane id: same %2 previously hosted dev-infra; new window is
# dev-investigation — must NOT steal infra's session.
got="$(agent_session_resolve_from_attention \
  "/tmp/tmux-1000/default" "wezterm_config_demo" "%2" "dev-investigation")"
[[ -z "$got" ]] || fail "window_name mismatch must reject, got=$got"
pass "reject attention hit when window_name mismatches"

got="$(agent_session_resolve_from_attention \
  "/tmp/tmux-1000/default" "wezterm_config_demo" "%2" "dev-infra")"
[[ "$got" == "live-sid-aaa" ]] || fail "matching window_name expected, got=$got"
pass "accept attention hit when window_name matches"

got="$(agent_session_resolve_from_attention \
  "/tmp/tmux-1000/default" "wezterm_config_demo" "%3" "dev-investigation")"
[[ -z "$got" ]] || fail "missing tmux_window_name must fail closed, got=$got"
pass "reject attention entry missing tmux_window_name under gate"

# --- env injection wins in resolve_current ---
WEZDECK_RESUME_SESSION_ID="env-sid-ccc"
got="$(agent_session_resolve_current)"
[[ "$got" == "env-sid-ccc" ]] || fail "env injection expected, got=$got"
unset WEZDECK_RESUME_SESSION_ID
pass "WEZDECK_RESUME_SESSION_ID wins in resolve_current"

# --- agent-resume typed argv ---
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN" "$TEST_ROOT/home"
FAKE_AGENT="$FAKE_BIN/fake-agent"
ARGS_LOG="$TEST_ROOT/agent.args"
cat > "$FAKE_AGENT" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$ARGS_LOG"
EOF
chmod +x "$FAKE_AGENT"
FALLBACK="$TEST_ROOT/fallback.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FALLBACK"
chmod +x "$FALLBACK"

env -i \
  HOME="$TEST_ROOT/home" \
  PATH="/usr/bin:/bin:$FAKE_BIN" \
  WEZDECK_RESUME_SESSION_ID="typed-sid-ddd" \
  bash "$REPO_ROOT/scripts/runtime/agent-resume.sh" \
    grok "$FALLBACK" "$FAKE_AGENT" base
grep -Fxq -- '--resume typed-sid-ddd' "$ARGS_LOG" \
  || fail "agent-resume must pass --resume <id>; got=$(cat "$ARGS_LOG")"
pass "agent-resume typed uses --resume <session_id>"

rm -f "$ARGS_LOG"
# No tmux / attention / injection → continue path (env -i strips TMUX_PANE)
env -i \
  HOME="$TEST_ROOT/home" \
  PATH="/usr/bin:/bin:$FAKE_BIN" \
  bash "$REPO_ROOT/scripts/runtime/agent-resume.sh" \
    grok "$FALLBACK" "$FAKE_AGENT" base || true
grep -Fxq -- '--continue' "$ARGS_LOG" \
  || fail "agent-resume without id must --continue; got=$(cat "$ARGS_LOG")"
pass "agent-resume without id uses --continue"

# --- durable pin ledger (kill-server survival) ---
export WEZDECK_AGENT_SESSION_PINS_PATH="$TEST_ROOT/agent-session-pins.json"
WT="$TEST_ROOT/worktree-a"
mkdir -p "$WT"
agent_session_pin_put "$WT" secondary "sec-sid-eee" grok
pin="$(agent_session_pin_get "$WT" secondary)"
[[ "$pin" == $'sec-sid-eee\tgrok' ]] || fail "pin get mismatch: $pin"
pass "durable pin put/get for secondary slot"

agent_session_pin_put "$WT" primary "pri-sid-fff" claude
pin="$(agent_session_pin_get "$WT" primary)"
[[ "$pin" == $'pri-sid-fff\tclaude' ]] || fail "primary pin mismatch: $pin"
# secondary still intact
pin="$(agent_session_pin_get "$WT" secondary)"
[[ "$pin" == $'sec-sid-eee\tgrok' ]] || fail "secondary pin clobbered: $pin"
pass "primary and secondary pins are independent"

agent_session_pin_clear "$WT" secondary
pin="$(agent_session_pin_get "$WT" secondary)"
[[ -z "$pin" ]] || fail "cleared secondary pin still present: $pin"
pass "durable pin clear"

cmd="$(agent_session_build_typed_resume_command "$REPO_ROOT" grok "sec-sid-eee")"
[[ "$cmd" == *"WEZDECK_RESUME_SESSION_ID=sec-sid-eee"* ]] \
  || fail "typed cmd missing env: $cmd"
[[ "$cmd" == *"agent-launcher.sh"* && "$cmd" == *" grok"* ]] \
  || fail "typed cmd missing launcher/agent: $cmd"
[[ "$cmd" == *"primary-pane-wrapper.sh"* ]] \
  || fail "typed cmd missing keep-alive wrapper: $cmd"
pass "build typed resume command for secondary"

printf 'ALL PASS\n'
