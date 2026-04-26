#!/usr/bin/env bash
# Orchestrator for the `mock-deck` WezDeck workspace demo.
#
# This script does NOT spawn tabs / tmux sessions itself — that's
# WezDeck's job once you switch to the `mock-deck` workspace (Alt+d →
# mock-deck). It only manages the *attention pipeline* state that the
# spawned mock agents observe:
#
#   1. Ensures the 6 fake project directories exist
#      (~/.cache/wezdeck/mock-projects/<project>-<slot>) so WezDeck has
#      a real cwd to spawn each tab into.
#   2. In `hero` scenario: drops a sentinel file and pins a fixed pose
#      in attention.json (running / waiting / done × 2 each → counter
#      ⟳ 2 ⚠ 2 ✓ 2). The sentinel makes every spawned agent suppress
#      its own emits so the pinned pose holds against races.
#   3. In `continuous` scenario: just creates the dirs and waits;
#      agents stream their tapes and emit transitions as they go.
#   4. Cleanup on Ctrl+C / EXIT: removes sentinel, removes demo entries
#      from attention.json, pkill mock-agent processes (so tabs in the
#      mock-deck workspace stop streaming).
#
# Recording flow:
#   1. Run this orchestrator from any pane:
#        scripts/dev/mock-deck/mock-deck.sh --scenario hero --hold 120 --reset
#   2. Press Alt+d → select `mock-deck`. Six tabs spawn:
#        cli-parser-1 / cli-parser-2 / image-resizer-1 / image-resizer-2
#        / log-daemon-1 / log-daemon-2.
#      Each tab has tab badge driven by its pinned hero status.
#   3. Right-status counter shows ⟳ 2 ⚠ 2 ✓ 2.
#   4. Capture the screenshot or GIF.
#   5. Ctrl+C the orchestrator. Cleanup runs.
#   6. Manually close the spawned tabs (or switch back to your normal
#      workspace and ignore them — they'll have stopped streaming).
#
# Flags:
#   --scenario <name>     hero (default) | continuous
#   --hold <seconds>      hero-mode hold duration before auto-cleanup
#                         (default 120; Ctrl+C aborts early)
#   --reset               truncate attention.json before pinning
#   --no-cleanup          skip teardown on exit (debug)
#   -h | --help

set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/attention-state-lib.sh"

scenario="hero"
hold_seconds=120
reset_first=0
do_cleanup=1

while (( $# > 0 )); do
  case "$1" in
    --scenario)    scenario="$2"; shift 2 ;;
    --hold)        hold_seconds="$2"; shift 2 ;;
    --reset)       reset_first=1; shift ;;
    --no-cleanup)  do_cleanup=0; shift ;;
    -h|--help)     sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
done

case "$scenario" in
  hero|continuous) ;;
  *) echo "scenario must be hero|continuous" >&2; exit 2 ;;
esac

PROJECTS=(cli-parser image-resizer log-daemon)
SLOTS=(1 2)

# Hero target state per project (both slots get the same state for a
# clean ⟳ 2 ⚠ 2 ✓ 2 pose).
declare -A HERO_STATE=(
  [cli-parser]=running
  [image-resizer]=waiting
  [log-daemon]=done
)
declare -A HERO_REASON=(
  [cli-parser]="parsing flag combinator"
  [image-resizer]="may I overwrite output/?"
  [log-daemon]="rotation policy verified"
)

state_dir="$HOME/.cache/wezdeck/mock-deck-state"
mock_projects_root="$HOME/.cache/wezdeck/mock-projects"
sentinel="$state_dir/hero-active"
mkdir -p "$state_dir"

export MOCK_DECK_STATE_DIR="$state_dir"
export MOCK_DECK_LOG="$state_dir/run.log"
: > "$MOCK_DECK_LOG"

mock_log() {
  local level="$1"; shift
  local ts; ts="$(date '+%H:%M:%S.%3N')"
  printf '%s %-5s [orchestrator] %s\n' "$ts" "$level" "$*" \
    >> "${MOCK_DECK_LOG:-/dev/null}"
}

osc_nudge() {
  local tick_ms encoded seq
  tick_ms="$(attention_state_now_ms)"
  encoded="$(printf '%s' "$tick_ms" | base64 | tr -d '\n')"
  seq="$(printf '\033]1337;SetUserVar=attention_tick=%s\007' "$encoded")"
  if [[ -n "${TMUX-}" ]]; then
    local escaped="${seq//$'\033'/$'\033\033'}"
    ( printf '\033Ptmux;%s\033\\' "$escaped" >/dev/tty ) 2>/dev/null || true
  else
    ( printf '%s' "$seq" >/dev/tty ) 2>/dev/null || true
  fi
}

# Ensure each mock project dir exists. WezDeck workspace items reference
# these as `cwd`; if they don't exist, the `mux.spawn_window` / `spawn_tab`
# calls fail and the whole workspace bootstrap aborts. Each dir gets a
# tiny placeholder file so it shows up as non-empty in `ls`.
ensure_project_dirs() {
  local project slot dir
  for project in "${PROJECTS[@]}"; do
    for slot in "${SLOTS[@]}"; do
      dir="$mock_projects_root/${project}-${slot}"
      if [[ ! -d "$dir" ]]; then
        mkdir -p "$dir"
        printf '# %s · slot %s · mock-deck demo project\n' "$project" "$slot" \
          > "$dir/README.md"
        mock_log INFO "created mock project dir: $dir"
      fi
    done
  done
}

demo_remove_all() {
  local project slot
  for project in "${PROJECTS[@]}"; do
    for slot in "${SLOTS[@]}"; do
      attention_state_remove "mock-deck-${project}-${slot}" 2>/dev/null || true
    done
  done
  osc_nudge
}

cleanup() {
  local exit_code=$?
  if (( ! do_cleanup )); then
    mock_log INFO "cleanup skipped (--no-cleanup); state at $state_dir"
    printf '\n--no-cleanup: hero sentinel + entries left in place.\n  rm %s; then re-run with --reset\n' "$sentinel" >&2
    return 0
  fi
  mock_log INFO "cleanup begin exit_code=$exit_code"
  printf '\ncleaning up…\n' >&2

  rm -f "$sentinel"

  # Stop every running mock-agent so tabs in the mock-deck workspace
  # stop streaming and stop re-emitting status (which would otherwise
  # repopulate attention.json a second after we cleared it).
  pkill -TERM -f "$script_dir/mock-agent.sh" 2>>"$MOCK_DECK_LOG" || true

  demo_remove_all
  mock_log INFO "cleanup done"
  cp -f "$MOCK_DECK_LOG" /tmp/mock-deck-last.log 2>/dev/null || true
  printf 'log: /tmp/mock-deck-last.log\n' >&2
  printf '(spawned tabs were not auto-closed; switch workspace away or close them manually)\n' >&2
}
trap cleanup EXIT INT TERM

mock_log INFO "mock-deck start pid=$$ scenario=$scenario hold=$hold_seconds"

ensure_project_dirs

(( reset_first )) && { demo_remove_all; mock_log INFO "demo entries cleared (real Claude entries preserved)"; }

printf '[mock-deck] scenario=%s · projects=%s\n' "$scenario" "${mock_projects_root#$HOME/}"
printf '[mock-deck] log: %s (mirrored to /tmp/mock-deck-last.log on exit)\n\n' "$MOCK_DECK_LOG"
printf '[mock-deck] In WezTerm, press \033[1mAlt+d → mock-deck\033[0m to spawn the 6 demo tabs.\n'
printf '            (mock-deck workspace is registered in wezterm-x/local/workspaces.lua)\n\n'

case "$scenario" in
  hero)
    mock_log INFO "writing hero sentinel + composing pose"
    : > "$sentinel"
    for project in "${PROJECTS[@]}"; do
      state="${HERO_STATE[$project]}"
      reason="${HERO_REASON[$project]}"
      for slot in "${SLOTS[@]}"; do
        sid="mock-deck-${project}-${slot}"
        if attention_state_upsert "$sid" "" "" "" "" "" "$state" "$reason" "demo" 2>>"$MOCK_DECK_LOG"; then
          mock_log INFO "upsert ok sid=$sid status=$state"
        else
          mock_log ERROR "upsert failed sid=$sid"
        fi
      done
    done
    osc_nudge
    printf '[mock-deck] HERO READY  ⟳ 2 ⚠ 2 ✓ 2  (hold %ds, Ctrl+C to abort)\n' "$hold_seconds"
    printf '[mock-deck] each spawned tab will respect the hero sentinel and stay silent;\n'
    printf '            the pinned pose holds until you Ctrl+C this orchestrator.\n'
    sleep "$hold_seconds"
    mock_log INFO "hero hold elapsed"
    ;;
  continuous)
    mock_log INFO "scenario=continuous wait loop"
    printf '[mock-deck] continuous mode · spawned agents emit their own status as tapes play.\n'
    printf '            Ctrl+C to clear demo entries + stop agents.\n'
    while :; do sleep 60; done
    ;;
esac
