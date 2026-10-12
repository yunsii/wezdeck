#!/usr/bin/env bash
# Coverage for agent-attention/lib/tmux-coords.sh + emit.sh wiring:
#   - recover coords from pane-session when TMUX is unset
#   - skip Claude fork/bg when recovery fails
#   - argv-token fork detect (no false positive on script source text)
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/attention-state-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/agent-attention/lib/tmux-coords.sh"

pass=0
fail=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ✓ $label"; pass=$((pass + 1))
  else
    echo "  ✗ $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail=$((fail + 1))
  fi
}

assert_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "  ✓ $label"; pass=$((pass + 1))
  else
    echo "  ✗ $label (command failed: $*)"
    fail=$((fail + 1))
  fi
}

assert_fail() {
  local label="$1"; shift
  if "$@"; then
    echo "  ✗ $label (expected failure)"
    fail=$((fail + 1))
  else
    echo "  ✓ $label"; pass=$((pass + 1))
  fi
}

echo "▸ fork detect: argv tokens only (no false positive on self)"
assert_fail "current shell is not a Claude fork/bg" attention_is_claude_fork_bg "$$"

# Spawn a fake child whose argv contains --fork-session.
fake_bin="$(mktemp)"
cat >"$fake_bin" <<'EOF'
#!/usr/bin/env bash
# Keep alive long enough for the parent to inspect /proc.
sleep 30
EOF
chmod +x "$fake_bin"
# argv0 is the script path; pass --fork-session as a real argument.
"$fake_bin" --fork-session &
fake_pid=$!
sleep 0.1
assert_ok "detect --fork-session on child argv" attention_is_claude_fork_bg "$fake_pid"
kill "$fake_pid" 2>/dev/null || true
wait "$fake_pid" 2>/dev/null || true
rm -f "$fake_bin"

echo "▸ recover: missing pane-session → fail"
sandbox="$(mktemp -d)"
export WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime"
export WINDOWS_LOCALAPPDATA_WSL="$sandbox"
export WINDOWS_USERPROFILE_WSL="$sandbox"
mkdir -p "$sandbox/wezterm-runtime/state/pane-session"
assert_fail "recover without pane-session file" \
  attention_recover_tmux_coords "42" "/tmp/nope"

echo "▸ recover: pane-session + mocked tmux cwd match"
mkdir -p "$sandbox/bin"
cat >"$sandbox/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
# Minimal mock: list-panes -s returns one pane with a known path.
case "${1:-}" in
  list-panes)
    # Expect: list-panes -s -t <session> -F '...'
    printf '%s\n' \
      '/tmp/tmux-test/default|sess-demo|@3|%24|dev-investigation|/home/demo/wt/dev-investigation'
    ;;
  display-message)
    printf '%s\n' '/tmp/tmux-test/default|sess-demo|@3|%24|dev-investigation'
    ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$sandbox/bin/tmux"
printf 'sess-demo\n' >"$sandbox/wezterm-runtime/state/pane-session/7.txt"
PATH="$sandbox/bin:$PATH" \
  out="$(attention_recover_tmux_coords 7 /home/demo/wt/dev-investigation || true)"
assert_eq "recover returns socket|session|window|pane|name" \
  "/tmp/tmux-test/default|sess-demo|@3|%24|dev-investigation" "$out"

echo "▸ emit.sh: no TMUX + pane-session recovery writes full coords"
hook="$repo_root/scripts/claude-hooks/emit-agent-status.sh"
mkdir -p "$sandbox/wezterm-runtime/state/agent-attention"
# Unset TMUX so the recover path runs; keep mock tmux on PATH.
env -u TMUX -u TMUX_PANE \
  HOME="$HOME" USER="$USER" SHELL="$SHELL" LANG="${LANG:-C}" \
  PATH="$sandbox/bin:$PATH" \
  WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime" \
  WINDOWS_LOCALAPPDATA_WSL="$sandbox" \
  WINDOWS_USERPROFILE_WSL="$sandbox" \
  WEZTERM_NO_PATH_CACHE=1 \
  WEZTERM_PANE="7" \
  CLAUDE_PROJECT_DIR="/home/demo/wt/dev-investigation" \
  PWD="/home/demo/wt/dev-investigation" \
  bash "$hook" done <<<"{\"session_id\":\"sid-recover\",\"stop_reason\":\"task done\"}" \
  >/dev/null 2>&1 || true

state="$sandbox/wezterm-runtime/state/agent-attention/attention.json"
assert_eq "emit recovered status=done" \
  "done" "$(jq -r '.entries["sid-recover"].status // ""' "$state")"
assert_eq "emit recovered tmux_session" \
  "sess-demo" "$(jq -r '.entries["sid-recover"].tmux_session // ""' "$state")"
assert_eq "emit recovered tmux_pane" \
  "%24" "$(jq -r '.entries["sid-recover"].tmux_pane // ""' "$state")"
assert_eq "emit recovered tmux_window_name" \
  "dev-investigation" "$(jq -r '.entries["sid-recover"].tmux_window_name // ""' "$state")"

rm -rf "$sandbox"

echo
echo "pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
