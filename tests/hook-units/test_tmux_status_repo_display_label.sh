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
unset TMUX_STATUS_REPO_ALIAS WEZTERM_REPO_ALIASES WEZTERM_REPO_ALIAS
tmux() { printf ''; }
export -f tmux
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wezdeck' 'default alias wezterm-config→wezdeck'
expect_eq "$(tmux_status_repo_display_label 'other-repo')" 'other-repo' 'unmapped basename unchanged'

# Shared Lua + shell alias takes effect before the tmux option fallback.
WEZTERM_REPO_ALIASES='wezterm-config=wd,other-repo=other'
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wd' 'shared alias wezterm-config→wd'
expect_eq "$(tmux_status_repo_display_label 'other-repo')" 'other' 'shared alias other-repo→other'
unset WEZTERM_REPO_ALIASES

# Explicit custom alias.
WEZTERM_REPO_ALIASES='team-stat=ts'
expect_eq "$(tmux_status_repo_display_label 'team-stat')" 'ts' 'custom alias team-stat→ts'
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wezterm-config' 'custom alias does not affect other basenames'

# Disable via sentinel / empty env.
WEZTERM_REPO_ALIASES='none'
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wezterm-config' 'none disables remapping'
WEZTERM_REPO_ALIASES=''
expect_eq "$(tmux_status_repo_display_label 'wezterm-config')" 'wezterm-config' 'empty env disables remapping'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
