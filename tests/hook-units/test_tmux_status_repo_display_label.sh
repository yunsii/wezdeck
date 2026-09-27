#!/usr/bin/env bash
# tmux_status_repo_display_label: basename → status-bar display name.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/tmux-status-lib.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  \xe2\x9c\x93 %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  \xe2\x9c\x97 %s\n' "$1"; }

expect_eq() {
  local got="$1"
  local want="$2"
  local label="$3"
  if [[ "$got" == "$want" ]]; then
    ok "$label"
  else
    no "$label (got='$got' want='$want')"
  fi
}

# Default remap (no tmux / env override): wezterm-config → wezdeck.
unset TMUX_STATUS_REPO_ALIAS WEZDECK_REPO_ALIASES WEZTERM_REPO_ALIASES WEZTERM_REPO_ALIAS
tmux() { printf ''; }
export -f tmux
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wezdeck' 'default alias wezterm-config→wezdeck'
expect_eq "$(tmux_status_repo_display_label 'other-repo')" 'other-repo' 'unmapped basename unchanged'

# Shared Lua + shell alias takes effect before the tmux option fallback.
WEZDECK_REPO_ALIASES='wezterm-config=wd,other-repo=other'
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wd' 'shared alias wezterm-config→wd'
expect_eq "$(tmux_status_repo_display_label 'other-repo')" 'other' 'shared alias other-repo→other'
unset WEZDECK_REPO_ALIASES

# Explicit custom alias.
WEZDECK_REPO_ALIASES='team-stat=ts'
expect_eq "$(tmux_status_repo_display_label 'team-stat')" 'ts' 'custom alias team-stat→ts'
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wezterm-config' 'custom alias does not affect other basenames'

# Disable via sentinel / empty env.
WEZDECK_REPO_ALIASES='none'
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wezterm-config' 'none disables remapping'
WEZDECK_REPO_ALIASES=''
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wezterm-config' 'empty env disables remapping'

# Retired name warns and does not override the current key.
WEZDECK_REPO_ALIASES='wezterm-config=wezdeck'
WEZTERM_REPO_ALIASES='wezterm-config=old'
warn="$(tmux_status_repo_display_label 'wezterm-config' 2>&1 >/dev/null || true)"
expect_eq "$(tmux_status_repo_display_label 'wezterm-config' 2>/dev/null)" 'wezdeck' 'retired WEZTERM_REPO_ALIASES is not applied'
case "$warn" in
  *'use WEZDECK_REPO_ALIASES'*) ok 'retired WEZTERM_REPO_ALIASES warns' ;;
  *) no "retired WEZTERM_REPO_ALIASES warns (got='$warn')" ;;
esac
unset WEZTERM_REPO_ALIASES WEZDECK_REPO_ALIASES

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
