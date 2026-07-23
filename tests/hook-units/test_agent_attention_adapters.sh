#!/usr/bin/env bash
# Provider adapter coverage for the agent-attention hook layer.
#
# Drive: scripts/dev/test-lua-units.sh (or run this file directly).
set -u

guard_sandbox_paths() {
  local p="$1"
  if [[ -z "$p" || "$p" == /mnt/c/* ]]; then
    echo "SAFETY ABORT: sandbox path resolves to live state ($p)" >&2
    exit 99
  fi
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
claude_adapter="$repo_root/scripts/runtime/agent-attention/adapters/claude.sh"
codex_adapter="$repo_root/scripts/runtime/agent-attention/adapters/codex.sh"

pass=0
fail=0

setup_sandbox() {
  local sandbox="$1" tmux_socket="$2" tmux_session="$3" tmux_pane="$4"
  guard_sandbox_paths "$sandbox/wezterm-runtime"
  mkdir -p "$sandbox/wezterm-runtime/state/agent-attention" "$sandbox/bin" "$sandbox/home" "$sandbox/project"
  cat > "$sandbox/bin/tmux" <<'TMUX_EOF'
#!/usr/bin/env bash
case "${1:-}" in
  display-message)
    fmt=""; want_fmt=0
    for arg in "$@"; do
      if (( want_fmt == 1 )); then fmt="$arg"; want_fmt=0
      elif [[ "$arg" == "-F" ]]; then want_fmt=1
      fi
    done
    out="$fmt"
    out="${out//#\{socket_path\}/${MOCK_TMUX_SOCKET}}"
    out="${out//#\{session_name\}/${MOCK_TMUX_SESSION}}"
    out="${out//#\{window_id\}/${MOCK_TMUX_WINDOW}}"
    out="${out//#\{pane_id\}/${MOCK_TMUX_PANE}}"
    out="${out//#\{pane_current_path\}/${HOME}}"
    printf '%s\n' "$out"
    ;;
  *) exit 0 ;;
esac
TMUX_EOF
  chmod +x "$sandbox/bin/tmux"

  export PATH="$sandbox/bin:$ORIGINAL_PATH"
  export HOME="$sandbox/home"
  export CODEX_PROJECT_DIR="$sandbox/project"
  export TMUX="dummy"
  export MOCK_TMUX_SOCKET="$tmux_socket"
  export MOCK_TMUX_SESSION="$tmux_session"
  export MOCK_TMUX_WINDOW="@1"
  export MOCK_TMUX_PANE="$tmux_pane"
  export WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime"
  export WINDOWS_LOCALAPPDATA_WSL="$sandbox"
  export WINDOWS_USERPROFILE_WSL="$sandbox"
  export WEZTERM_NO_PATH_CACHE=1
  export WEZTERM_PANE="42"
  export TMUX_PANE="$tmux_pane"
}

state_file_in() {
  printf '%s/wezterm-runtime/state/agent-attention/attention.json' "$1"
}

field_for() {
  local sandbox="$1" sid="$2" field="$3"
  jq -r --arg s "$sid" --arg f "$field" \
    '.entries[$s][$f] // ""' "$(state_file_in "$sandbox")" 2>/dev/null \
    || printf ''
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ✓ $label"; pass=$((pass+1))
  else
    echo "  ✗ $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail=$((fail+1))
  fi
}

ORIGINAL_PATH="$PATH"
ORIGINAL_HOME="$HOME"
socket="/tmp/tmux-1000/default"
session="wezterm_test_x_aaaaaaaaaa"

echo "▸ agent-attention provider adapters"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"thread_id":"codex-thread-1","prompt":"build it\nwith details","hook_event_name":"UserPromptSubmit"}' \
  | "$codex_adapter" running >/dev/null 2>&1 || true
assert_eq "Codex thread_id keys the entry" "running" "$(field_for "$sandbox" "codex-thread-1" "status")"
assert_eq "Codex prompt first line becomes reason" "build it" "$(field_for "$sandbox" "codex-thread-1" "reason")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"threadId":"codex-thread-2","tool_name":"Bash","hook_event_name":"PermissionRequest"}' \
  | "$codex_adapter" waiting >/dev/null 2>&1 || true
assert_eq "Codex threadId fallback works" "waiting" "$(field_for "$sandbox" "codex-thread-2" "status")"
assert_eq "Codex permission reason falls back to tool name" "Bash" "$(field_for "$sandbox" "codex-thread-2" "reason")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
mkdir -p "$HOME/.codex"
printf '%s\n' 'approvals_reviewer = "auto_review"' > "$HOME/.codex/config.toml"
printf '%s' '{"thread_id":"codex-thread-auto","prompt":"continue","hook_event_name":"UserPromptSubmit"}' \
  | "$codex_adapter" running >/dev/null 2>&1 || true
printf '%s' '{"thread_id":"codex-thread-auto","tool_name":"Bash","hook_event_name":"PermissionRequest"}' \
  | "$codex_adapter" waiting >/dev/null 2>&1 || true
assert_eq "Codex auto-review PermissionRequest does not become waiting" "running" "$(field_for "$sandbox" "codex-thread-auto" "status")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"session_id":"claude-session-1","prompt":"hello claude\nsecond","hook_event_name":"UserPromptSubmit"}' \
  | "$claude_adapter" running >/dev/null 2>&1 || true
assert_eq "Claude adapter preserves session_id" "running" "$(field_for "$sandbox" "claude-session-1" "status")"
assert_eq "Claude adapter preserves prompt reason" "hello claude" "$(field_for "$sandbox" "claude-session-1" "reason")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"session_id":"claude-wait-1","hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}' \
  | "$claude_adapter" waiting >/dev/null 2>&1 || true
assert_eq "Claude permission_prompt becomes waiting" "waiting" "$(field_for "$sandbox" "claude-wait-1" "status")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"session_id":"claude-idle-1","hook_event_name":"UserPromptSubmit","prompt":"go"}' \
  | "$claude_adapter" running >/dev/null 2>&1 || true
printf '%s' '{"session_id":"claude-idle-1","hook_event_name":"Notification","notification_type":"idle_prompt","message":"idle"}' \
  | "$claude_adapter" waiting >/dev/null 2>&1 || true
assert_eq "Claude idle_prompt does not flip running" "running" "$(field_for "$sandbox" "claude-idle-1" "status")"
rm -rf "$sandbox"

# Grok loads Claude hooks via compat and sends camelCase payloads. Turn
# complete fires Notification with message "Turn complete" — must NOT raise
# ⚠ waiting after a correct Stop→done.
sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"sessionId":"grok-session-1","hookEventName":"UserPromptSubmit","prompt":"fix waiting\nmore"}' \
  | "$claude_adapter" running >/dev/null 2>&1 || true
assert_eq "Grok camelCase sessionId keys the entry" "running" "$(field_for "$sandbox" "grok-session-1" "status")"
assert_eq "Grok camelCase prompt becomes reason" "fix waiting" "$(field_for "$sandbox" "grok-session-1" "reason")"
printf '%s' '{"sessionId":"grok-session-1","hookEventName":"Stop","stopReason":"end_turn","message":"Turn complete"}' \
  | "$claude_adapter" done >/dev/null 2>&1 || true
assert_eq "Grok Stop becomes done" "done" "$(field_for "$sandbox" "grok-session-1" "status")"
printf '%s' '{"sessionId":"grok-session-1","hookEventName":"Notification","message":"Turn complete"}' \
  | "$claude_adapter" waiting >/dev/null 2>&1 || true
assert_eq "Grok turn_complete Notification does not overwrite done" "done" "$(field_for "$sandbox" "grok-session-1" "status")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"sessionId":"grok-session-2","hookEventName":"Notification","notificationType":"turn_complete","message":"Turn complete"}' \
  | "$claude_adapter" waiting >/dev/null 2>&1 || true
assert_eq "Grok notificationType=turn_complete creates no entry" "" "$(field_for "$sandbox" "grok-session-2" "status")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"sessionId":"grok-session-3","hookEventName":"Notification","notificationType":"approval_required","message":"Needs approval"}' \
  | "$claude_adapter" waiting >/dev/null 2>&1 || true
assert_eq "Grok approval_required becomes waiting" "waiting" "$(field_for "$sandbox" "grok-session-3" "status")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
# Legacy unparsed path: empty raw_event + reason "Turn complete" (pre-camelCase).
printf '%s' '{"message":"Turn complete"}' \
  | "$claude_adapter" waiting >/dev/null 2>&1 || true
assert_eq "Bare Turn complete reason does not create waiting" "" "$(field_for "$sandbox" "pane:42" "status")"
rm -rf "$sandbox"

sandbox="$(mktemp -d)"
setup_sandbox "$sandbox" "$socket" "$session" "%5"
printf '%s' '{"message":"no stable id"}' \
  | "$codex_adapter" done >/dev/null 2>&1 || true
assert_eq "Codex adapter falls back to pane key" "done" "$(field_for "$sandbox" "pane:42" "status")"
rm -rf "$sandbox"

export HOME="$ORIGINAL_HOME"

echo
if (( fail > 0 )); then
  echo "$pass passed, $fail failed"
  exit 1
fi
echo "$pass passed, $fail failed"
