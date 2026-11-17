#!/usr/bin/env bash
# Run Lua unit tests for wezterm-x/lua/ modules.
#
# These tests mock wezterm.* and exercise the modules directly with
# lua5.4 — no wezterm process required. Use this as the first-line
# regression net for attention.lua / tab_visibility.lua changes
# instead of asking the user to manually press Alt+/ each iteration.
#
# Hook suites (tests/hook-units/) run in parallel, output printed in order
# with per-file wall time. Knobs: WEZTERM_TEST_JOBS (default nproc; 1 =
# serial), WEZTERM_TEST_SUITE_TIMEOUT (seconds per file, default 180).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if ! command -v lua5.4 >/dev/null 2>&1; then
  echo "lua5.4 not on PATH; install it with: sudo apt install lua5.4" >&2
  exit 2
fi

# Sandbox the state-file roots the modules under test resolve from
# env. tab_visibility's pane_session_dir() falls back to
# LOCALAPPDATA (hybrid-wsl) or XDG_STATE_HOME/HOME, so without this a
# file-tier test would read and delete entries under the user's REAL
# wezterm-runtime state (a 2026-05-06 trace corrupted attention.json
# exactly this way).
lua_state_root="$(mktemp -d)"
trap 'rm -rf "$lua_state_root"' EXIT
unset LOCALAPPDATA
export XDG_STATE_HOME="$lua_state_root"
# Claude bg-task reconcile walks this root for <session>/tasks; keep hook
# fires off the host's real /tmp (slow, and it can see live sessions).
mkdir -p "$lua_state_root/claude-tasks"
export WEZTERM_ATTENTION_CLAUDE_TASKS_ROOT="$lua_state_root/claude-tasks"

# Per-file wall-clock cap, so one hung suite fails loudly instead of
# stalling the whole run. Jobs: hook suites are independent (each builds
# its own mktemp sandbox), so they run concurrently; output is buffered per
# file and printed in the original order. WEZTERM_TEST_JOBS=1 serializes.
suite_timeout="${WEZTERM_TEST_SUITE_TIMEOUT:-180}"
jobs="${WEZTERM_TEST_JOBS:-$(nproc 2>/dev/null || echo 4)}"
(( jobs >= 1 )) || jobs=1

failures=0
for t in tests/lua-units/test_*.lua; do
  echo "── $t"
  if ! timeout "$suite_timeout" lua5.4 "$t"; then
    failures=$((failures + 1))
  fi
done

# Hook-side bash suites cover behavior that lives in
# scripts/claude-hooks/ and scripts/runtime/ (e.g. the focused-pane
# upsert suppression). They mock state files in a tmpdir, so they
# do not touch the user's real attention.json.
out_dir="$lua_state_root/hook-out"
mkdir -p "$out_dir"
hook_suites=()
for t in tests/hook-units/test_*.sh; do
  [[ -f "$t" ]] && hook_suites+=("$t")
done

run_suite() {
  local t="$1" out="$out_dir/$(basename "$t").out" rc=0 start
  start="$(date +%s%N)"
  timeout -k 5 "$suite_timeout" bash "$t" >"$out" 2>&1 || rc=$?
  (( rc == 124 || rc == 137 )) && printf 'TIMEOUT after %ss\n' "$suite_timeout" >>"$out"
  printf '%s %s\n' "$rc" "$(( ($(date +%s%N) - start) / 1000000 ))" >"$out.rc"
}

running=0
for t in "${hook_suites[@]}"; do
  run_suite "$t" &
  running=$((running + 1))
  if (( running >= jobs )); then
    wait -n || true
    running=$((running - 1))
  fi
done
wait

for t in "${hook_suites[@]}"; do
  out="$out_dir/$(basename "$t").out"
  read -r rc ms <"$out.rc" 2>/dev/null || { rc=1; ms='?'; }
  echo "── $t (${ms}ms)"
  cat "$out"
  (( rc == 0 )) || failures=$((failures + 1))
done

if (( failures > 0 )); then
  echo "$failures test file(s) failed" >&2
  exit 1
fi
echo "all unit suites passed"
