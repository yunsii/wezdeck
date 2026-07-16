#!/usr/bin/env bash
# menu-bench-lib.sh — microbench short-circuit shared by popup menu
# wrappers (attention / command / worktree).
#
# When WEZTERM_BENCH_NO_POPUP=1:
#   - menu_bench_init installs bench_mark <stage> (µs-since-start via
#     EPOCHREALTIME, zero fork)
#   - menu_bench_dump_and_exit prints a __BENCH__ line for
#     scripts/dev/bench-menu-prep.sh and exits before display-popup
#
# When the env var is unset, bench_mark is a no-op and dump is a no-op
# return so the caller's cleanup can stay in the normal path.
#
# Sourced only — not executed as a standalone script.
# shellcheck shell=bash

if [[ -n "${__MENU_BENCH_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__MENU_BENCH_LIB_LOADED=1

menu_bench_init() {
  if [[ -n "${WEZTERM_BENCH_NO_POPUP:-}" ]]; then
    bench_marks=()
    bench_t0="${EPOCHREALTIME//./}"
    bench_mark() { bench_marks+=("$1=$((${EPOCHREALTIME//./} - bench_t0))"); }
  else
    bench_mark() { :; }
  fi
}

menu_bench_active() {
  [[ -n "${WEZTERM_BENCH_NO_POPUP:-}" ]]
}

# menu_bench_dump_and_exit [field=value ...]
# Prints `__BENCH__ <fields...> <stage=µs...>` and exits 0 when bench
# mode is on. Returns 1 when inactive so callers can fall through.
# Callers must clean temp files *before* invoking this when active.
menu_bench_dump_and_exit() {
  menu_bench_active || return 1
  printf '__BENCH__'
  local field
  for field in "$@"; do
    printf ' %s' "$field"
  done
  if ((${#bench_marks[@]} > 0)); then
    printf ' %s' "${bench_marks[*]}"
  fi
  printf '\n'
  exit 0
}
