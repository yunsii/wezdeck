#!/usr/bin/env bash
# Context compaction and turn start in attention.json (emit.sh compacting /
# compacted, attention-state-lib.sh turn_started / compact_*): the phone
# shows "正在压缩上下文… 36s" and the turn's elapsed time from these fields
# instead of reading the TUI's screen.
#
# Every case runs in its own sandbox (WINDOWS_RUNTIME_STATE_WSL under a
# temp dir; aborts if a path would reach /mnt/c). Drive:
# scripts/dev/test-lua-units.sh, or run this file directly.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hook="$repo_root/scripts/claude-hooks/emit-agent-status.sh"
pass=0
fail=0

guard() {
  if [[ -z "$1" || "$1" == /mnt/c/* ]]; then
    echo "SAFETY ABORT: sandbox path resolves to live state ($1)" >&2
    exit 99
  fi
}

new_sandbox() {
  local dir
  dir="$(mktemp -d)"
  guard "$dir/wezterm-runtime"
  mkdir -p "$dir/wezterm-runtime/state/agent-attention" "$dir/bin"
  # focus elsewhere: done / waiting upserts are not skipped as focused
  printf '{"focused_wezterm_pane_id":"999"}\n' \
    > "$dir/wezterm-runtime/state/agent-attention/live-panes.json"
  cat > "$dir/bin/tmux" <<'TMUX_EOF'
#!/usr/bin/env bash
[[ "${1:-}" != "-S" ]] || shift 2
case "${1:-}" in
  display-message)
    fmt=""; want=0
    for arg in "$@"; do
      if (( want == 1 )); then fmt="$arg"; want=0
      elif [[ "$arg" == "-F" ]]; then want=1; fi
    done
    out="$fmt"
    out="${out//#\{socket_path\}//tmp/test-sock}"
    out="${out//#\{session_name\}/s}"
    out="${out//#\{window_id\}/@1}"
    out="${out//#\{pane_id\}/%7}"
    out="${out//#\{pane_current_path\}/${HOME}}"
    out="${out//#\{@wezdeck_interrupted_turn\}/${TEST_INTERRUPTED_TURN:-}}"
    printf '%s\n' "$out"
    ;;
  *) exit 0 ;;
esac
TMUX_EOF
  chmod +x "$dir/bin/tmux"
  printf '%s' "$dir"
}

# hook <sandbox> <status> <event> [session id]
hook() {
  local sandbox="$1" status="$2" event="$3" sid="${4:-s1}"
  env HOME="$HOME" USER="${USER:-}" LANG="${LANG:-C}" \
    PATH="$sandbox/bin:$PATH" TMUX="dummy" \
    WINDOWS_RUNTIME_STATE_WSL="$sandbox/wezterm-runtime" \
    WINDOWS_LOCALAPPDATA_WSL="$sandbox" WINDOWS_USERPROFILE_WSL="$sandbox" \
    WEZTERM_NO_PATH_CACHE=1 WEZTERM_PANE="7" TMUX_PANE="%7" \
    bash "$hook" "$status" \
    <<<"{\"session_id\":\"$sid\",\"hook_event_name\":\"$event\",\"prompt\":\"hi\"}" \
    >/dev/null 2>&1 || true
}

entry() { # entry <sandbox> <jq filter on the s1 entry>
  jq -r ".entries.s1 // {} | $2" \
    "$1/wezterm-runtime/state/agent-attention/attention.json" 2>/dev/null
}

check() { # check <label> <got> <want>
  if [[ "$2" == "$3" ]]; then
    echo "  ✓ $1"; pass=$((pass+1))
  else
    echo "  ✗ $1: got '$2', want '$3'"; fail=$((fail+1))
  fi
}

echo "turn_started"
sb="$(new_sandbox)"
hook "$sb" running UserPromptSubmit
first="$(entry "$sb" '.turn_started // ""')"
check "a prompt starts the turn" "$([[ -n "$first" ]] && echo set)" "set"
sleep 0.05
hook "$sb" running UserPromptSubmit
check "a queued prompt mid-turn keeps it" "$(entry "$sb" '.turn_started')" "$first"
TEST_INTERRUPTED_TURN="s1/$first" hook "$sb" running UserPromptSubmit
after_interrupt="$(entry "$sb" '.turn_started')"
check "a prompt after a confirmed interrupt starts a new turn" \
  "$([[ "$after_interrupt" -gt "$first" ]] && echo new)" "new"
TEST_INTERRUPTED_TURN="s1/$first" hook "$sb" running UserPromptSubmit
check "a stale interrupt does not reset an active turn" "$(entry "$sb" '.turn_started')" "$after_interrupt"
hook "$sb" done Stop
check "done drops it" "$(entry "$sb" '.turn_started // "none"')" "none"
sleep 0.05
hook "$sb" running UserPromptSubmit
check "the next prompt starts a new turn" \
  "$([[ "$(entry "$sb" '.turn_started')" != "$first" ]] && echo new)" "new"
rm -rf "$sb"

echo "auto compaction mid-turn"
sb="$(new_sandbox)"
hook "$sb" running UserPromptSubmit
turn="$(entry "$sb" '.turn_started')"
hook "$sb" compacting PreCompact
check "status stays running" "$(entry "$sb" '.status')" "running"
check "running_kind=compacting" "$(entry "$sb" '.running_kind')" "compacting"
check "remembers it came from running" "$(entry "$sb" '.compact_from')" "running"
check "compact_started set" "$(entry "$sb" 'has("compact_started")')" "true"
check "turn_started kept" "$(entry "$sb" '.turn_started')" "$turn"
hook "$sb" compacted SessionStart
check "after: running" "$(entry "$sb" '.status')" "running"
check "after: no running_kind" "$(entry "$sb" '.running_kind // "none"')" "none"
check "after: compact marks gone" "$(entry "$sb" 'has("compact_started")')" "false"
check "after: same turn" "$(entry "$sb" '.turn_started')" "$turn"
rm -rf "$sb"

echo "a tool call ends the compaction (SessionStart not first)"
sb="$(new_sandbox)"
hook "$sb" running UserPromptSubmit
turn="$(entry "$sb" '.turn_started')"
hook "$sb" compacting PreCompact
hook "$sb" resolved PreToolUse
check "running_kind cleared" "$(entry "$sb" '.running_kind // "none"')" "none"
check "turn kept" "$(entry "$sb" '.turn_started')" "$turn"
hook "$sb" compacted SessionStart
check "late compacted is a no-op" "$(entry "$sb" '.status')/$(entry "$sb" '.running_kind // "none"')" "running/none"
rm -rf "$sb"

echo "manual /compact after the turn"
sb="$(new_sandbox)"
hook "$sb" running UserPromptSubmit
hook "$sb" done Stop
hook "$sb" compacting PreCompact
check "compacting shows as running" "$(entry "$sb" '.status')/$(entry "$sb" '.running_kind')" "running/compacting"
check "came from done" "$(entry "$sb" '.compact_from')" "done"
hook "$sb" compacted SessionStart
check "back to done" "$(entry "$sb" '.status')" "done"
rm -rf "$sb"

echo "manual /compact with no entry"
sb="$(new_sandbox)"
hook "$sb" compacting PreCompact
check "an entry while compacting" "$(entry "$sb" '.running_kind')" "compacting"
hook "$sb" compacted SessionStart
check "cleared again" "$(entry "$sb" '.status // "none"')" "none"
rm -rf "$sb"

echo "compacted without compacting"
sb="$(new_sandbox)"
hook "$sb" running UserPromptSubmit
hook "$sb" done Stop
hook "$sb" compacted SessionStart
check "entry untouched" "$(entry "$sb" '.status')" "done"
rm -rf "$sb"

echo "/clear marks the archived session cleared_to the new one"
sb="$(new_sandbox)"
hook "$sb" running UserPromptSubmit
hook "$sb" done Stop
hook "$sb" pane-evict SessionStart s2
recent() {
  jq -r ".recent // [] | map(select(.session_id == \"$2\")) | .[0] | $3" \
    "$1/wezterm-runtime/state/agent-attention/attention.json" 2>/dev/null
}
check "old entry left .entries" "$(entry "$sb" '.status // "none"')" "none"
check "archived entry points at the new session" "$(recent "$sb" s1 '.cleared_to // ""')" "s2"
rm -rf "$sb"

echo "/resume after /new overwrites cleared_to and stubs the phantom"
sb="$(new_sandbox)"
hook "$sb" running UserPromptSubmit
hook "$sb" done Stop
hook "$sb" pane-evict SessionStart s2
# Terminal resumes s1 while the web is still on phantom s2.
hook "$sb" pane-evict SessionStart s1
check "resumed session drops cleared_to" "$(recent "$sb" s1 '.cleared_to // ""')" ""
check "phantom fresh id points at resumed" "$(recent "$sb" s2 '.cleared_to // ""')" "s1"
rm -rf "$sb"

echo
echo "compaction / turn: $pass passed, $fail failed"
(( fail == 0 ))
