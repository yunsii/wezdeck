#!/usr/bin/env bash
# Packing / visibility helpers for tmux status rows.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/tmux-status-lib.sh"

pass=0
fail=0

assert_yes() {
  local name="$1"
  local cond="$2"
  if [[ "$cond" == "yes" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n' "$name"
  fi
}

tmux_status_line_is_visible '#[fg=#393a34,bold]dev-coco-platform#[default]' \
  && assert_yes "styled content visible" "yes" \
  || assert_yes "styled content visible" "no"

tmux_status_line_is_visible '   ' \
  && assert_yes "whitespace-only hidden" "no" \
  || assert_yes "whitespace-only hidden" "yes"

tmux_status_line_is_visible '#[fg=#7f7a72]#[default]' \
  && assert_yes "style-only hidden" "no" \
  || assert_yes "style-only hidden" "yes"

tmux_status_line_is_visible '' \
  && assert_yes "empty hidden" "no" \
  || assert_yes "empty hidden" "yes"

# Structural: layout packs into consecutive slots and even-horizontal on change.
layout="$repo_root/scripts/runtime/tmux-status-layout.sh"
grep -q 'packed_lines' "$layout" && assert_yes "layout packs lines" "yes" || assert_yes "layout packs lines" "no"
grep -q 'even-horizontal' "$layout" && assert_yes "layout rebalances on status change" "yes" || assert_yes "layout rebalances on status change" "no"
grep -q 'tmux_status_line_is_visible' "$layout" && assert_yes "layout uses visibility helper" "yes" || assert_yes "layout uses visibility helper" "no"

waka="$repo_root/scripts/runtime/tmux-status-wakatime.sh"
grep -q 'WakaTime unavailable' "$waka" \
  && assert_yes "wakatime no longer prints unavailable placeholder" "no" \
  || assert_yes "wakatime no longer prints unavailable placeholder" "yes"
grep -q 'Ready to roll' "$waka" \
  && assert_yes "wakatime no longer prints ready placeholder" "no" \
  || assert_yes "wakatime no longer prints ready placeholder" "yes"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
