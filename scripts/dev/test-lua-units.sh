#!/usr/bin/env bash
# Run Lua unit tests for wezterm-x/lua/ modules.
#
# These tests mock wezterm.* and exercise the modules directly with
# lua5.4 — no wezterm process required. Use this as the first-line
# regression net for attention.lua / tab_visibility.lua changes
# instead of asking the user to manually press Alt+/ each iteration.
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

failures=0
for t in tests/lua-units/test_*.lua; do
  echo "── $t"
  if ! lua5.4 "$t"; then
    failures=$((failures + 1))
  fi
done

# Hook-side bash suites cover behavior that lives in
# scripts/claude-hooks/ and scripts/runtime/ (e.g. the focused-pane
# upsert suppression). They mock state files in a tmpdir, so they
# do not touch the user's real attention.json.
for t in tests/hook-units/test_*.sh; do
  [[ -f "$t" ]] || continue
  echo "── $t"
  if ! bash "$t"; then
    failures=$((failures + 1))
  fi
done

if (( failures > 0 )); then
  echo "$failures test file(s) failed" >&2
  exit 1
fi
echo "all unit suites passed"
