#!/usr/bin/env bash
# Typewriter agent. Reads a tape file and renders Claude-Code-like output
# while emitting attention status transitions through the real hook
# (emit-agent-status.sh), so the spawned pane's coords drive tab badges
# and the right-status counter the same way a real Claude session would.
#
# In hero mode (MOCK_DECK_NO_STATUS=1) status emits are suppressed so the
# orchestrator can pin the pose without racing the agent.
#
# Usage: mock-agent.sh <tape-path> <project-name>
#
# Tape grammar (one command per line, # for comments):
#   delay <ms>             pause (scaled by MOCK_DECK_SPEED)
#   type  <text>           typewriter print at ~25 ms/char
#   print <text>           instant print + newline
#   clear                  clear screen and home cursor
#   prompt <text>          render quoted user-prompt block
#   read   <path>          render `● Read(<path>)`
#   edit   <path>          render `▶ Edit(<path>)`
#   write  <path>          render `▶ Write(<path>)`
#   bash   <cmd…>          render `■ Bash(<cmd>)`
#   grep   <pattern>       render `● Grep(<pattern>)`
#   result <text>          render dim `  ⎿ <text>`
#   heading <text>         render bold heading line
#   status <s> [reason]    s ∈ {running,waiting,done}; reason is rest of line
#   wait                   in continuous mode, block until the user presses
#                          Enter inside this pane (mimics resolving a real
#                          PermissionPrompt that flips waiting → running);
#                          in hero mode (sentinel set), short nap so the
#                          tape keeps streaming for visual interest while
#                          the orchestrator's pinned pose holds.

set -u

tape="${1:-}"
project="${2:-mock}"
[[ -f "$tape" ]] || { echo "tape not found: $tape" >&2; exit 1; }

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
hook="$repo_root/scripts/claude-hooks/emit-agent-status.sh"

speed="${MOCK_DECK_SPEED:-1.0}"
slot="${MOCK_DECK_SLOT:-1}"
session_id="mock-deck-${project}-${slot}"
no_status="${MOCK_DECK_NO_STATUS:-0}"

mock_log() {
  local level="$1"; shift
  local ts; ts="$(date '+%H:%M:%S.%3N')"
  printf '%s %-5s [agent/%s.%s] %s\n' "$ts" "$level" "$project" "$slot" "$*" \
    >> "${MOCK_DECK_LOG:-/dev/null}"
}
mock_log INFO "agent start tape=$tape session_id=$session_id no_status=$no_status WEZTERM_PANE=${WEZTERM_PANE:-} TMUX_PANE=${TMUX_PANE:-}"

# Convert ms → seconds scaled by speed. Single awk per call (cheap).
nap_ms() { awk -v ms="$1" -v f="$speed" 'BEGIN { printf "%.3f", (ms/1000)/f }' | xargs sleep; }

# Per-character delay precomputed so the typewriter loop avoids per-char awk.
char_delay="$(awk -v f="$speed" 'BEGIN { printf "%.4f", 0.025/f }')"

typewriter() {
  local text="$1" i ch
  for (( i=0; i<${#text}; i++ )); do
    ch="${text:$i:1}"
    printf '%s' "$ch"
    sleep "$char_delay"
  done
  printf '\n'
}

emit_status() {
  if (( no_status )); then
    mock_log INFO "emit_status suppressed (env no-status) status=$1 reason=$2"
    return 0
  fi
  # Hero sentinel: when the orchestrator is in hero scenario, it writes
  # this file so every running agent (including ones spawned by WezDeck
  # *after* the orchestrator started) suppresses its own emits. The
  # orchestrator's pinned attention.json then renders a stable pose
  # without races. Sentinel removal in the orchestrator's cleanup trap
  # restores normal continuous behavior.
  local sentinel="${MOCK_DECK_STATE_DIR:-$HOME/.cache/wezdeck/mock-deck-state}/hero-active"
  if [[ -f "$sentinel" ]]; then
    mock_log INFO "emit_status suppressed (hero sentinel) status=$1 reason=$2"
    return 0
  fi
  local status="$1" reason="$2"
  # Real spawn under the workspace path: pane has a real WEZTERM_PANE.
  # Pass it through so attention.lua can resolve tab + render badge.
  if command -v jq >/dev/null 2>&1; then
    local payload
    payload="$(jq -n --arg sid "$session_id" --arg msg "$reason" \
      '{hook_event_name:"mock", session_id:$sid, message:$msg}')"
    if printf '%s' "$payload" | "$hook" "$status" 2>>"${MOCK_DECK_LOG:-/dev/null}"; then
      mock_log INFO "emit_status status=$status reason=$reason"
    else
      mock_log WARN "emit_status hook returned non-zero status=$status"
    fi
  else
    "$hook" "$status" 2>>"${MOCK_DECK_LOG:-/dev/null}" \
      && mock_log INFO "emit_status (no-jq) status=$status" \
      || mock_log WARN "emit_status (no-jq) hook failed status=$status"
  fi
}

render_prompt() {
  local text="$1"
  # Open-ended frame (no right border) so prompts longer than the pane
  # width don't visibly tear the box. Dim left bar + dim header is enough
  # to read as a quoted user message.
  printf '\n\033[2m┌─ user\033[0m\n'
  printf '\033[2m│\033[0m \033[36m%s\033[0m\n' "$text"
  printf '\033[2m└─\033[0m\n\n'
}

# Claude-Code tool-call shapes. ● = read-only / introspection, ▶ = mutation,
# ■ = shell. Colors are subtle so the demo doesn't read as a parody.
render_read()    { printf '\033[36m●\033[0m Read(\033[2m%s\033[0m)\n' "$1"; }
render_grep()    { printf '\033[36m●\033[0m Grep(\033[2m%s\033[0m)\n' "$1"; }
render_edit()    { printf '\033[33m▶\033[0m Edit(\033[2m%s\033[0m)\n' "$1"; }
render_write()   { printf '\033[33m▶\033[0m Write(\033[2m%s\033[0m)\n' "$1"; }
render_bash()    { printf '\033[35m■\033[0m Bash(\033[2m%s\033[0m)\n' "$1"; }
render_result()  { printf '\033[2m  ⎿\033[0m \033[2m%s\033[0m\n' "$1"; }
render_heading() { printf '\n\033[1m%s\033[0m\n' "$1"; }

await_user() {
  local sentinel="${MOCK_DECK_STATE_DIR:-$HOME/.cache/wezdeck/mock-deck-state}/hero-active"
  if [[ -f "$sentinel" ]]; then
    # Hero mode: orchestrator owns the pose; tape should keep streaming.
    nap_ms 1500
    return 0
  fi
  # Continuous mode: wait for the user to press Enter in this pane —
  # mimics resolving a real permission prompt. 600s timeout so a
  # forgotten demo eventually unblocks.
  printf '\n\033[2m  ⏳ awaiting your response — press Enter in this pane to continue\033[0m\n'
  read -t 600 -r _ </dev/tty 2>/dev/null || true
  printf '\033[2m  ✓ continuing\033[0m\n\n'
}

# Banner so the pane doesn't start blank before the tape's first delay.
clear
printf '\033[2m── mock %s · %s · slot %s ──\033[0m\n' "$project" "$(basename "${tape%.tape}")" "$slot"
sleep 1

run_tape() {
  local cmd rest
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    [[ -z "$raw_line" || "$raw_line" =~ ^[[:space:]]*# ]] && continue
    cmd="${raw_line%% *}"
    if [[ "$raw_line" == *' '* ]]; then rest="${raw_line#* }"; else rest=""; fi
    case "$cmd" in
      delay)   nap_ms "$rest" ;;
      type)    typewriter "$rest" ;;
      print)   printf '%s\n' "$rest" ;;
      clear)   printf '\033[2J\033[H' ;;
      prompt)  render_prompt "$rest" ;;
      read)    render_read "$rest" ;;
      grep)    render_grep "$rest" ;;
      edit)    render_edit "$rest" ;;
      write)   render_write "$rest" ;;
      bash)    render_bash "$rest" ;;
      result)  render_result "$rest" ;;
      heading) render_heading "$rest" ;;
      wait)    await_user ;;
      status)
        local s="${rest%% *}" r=""
        [[ "$rest" == *' '* ]] && r="${rest#* }"
        emit_status "$s" "$r"
        ;;
      *) printf '\033[31m[tape parse error: %s]\033[0m\n' "$cmd" ;;
    esac
  done < "$tape"
}

# Loop the tape forever (hero mode included — tape keeps streaming text
# while the orchestrator's pinned status holds; continuous mode emits its
# own statuses every loop). On signal, exit cleanly so the parent tmux
# pane closes, which the orchestrator's cleanup catches.
while :; do
  run_tape
  emit_status cleared ""
  nap_ms 4000
done
