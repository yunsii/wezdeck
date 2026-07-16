#!/usr/bin/env bash
# picker-bin-lib.sh — resolve the Go picker binary for tmux popups.
#
# Product policy (Go-only): high-frequency pickers (attention / worktree /
# command / overflow) require native/picker/bin/picker. Bash pickers and
# overflow's display-menu path remain only behind the explicit escape hatch
# WEZTERM_ALLOW_BASH_PICKER=1 for emergency recovery when install is broken.
#
# Install: native/picker/build.sh (local go | release tarball), invoked by
# wezterm-runtime-sync. See docs/picker-release.md.
#
# Sourced only — not a standalone CLI.
# shellcheck shell=bash

if [[ -n "${__PICKER_BIN_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__PICKER_BIN_LIB_LOADED=1

# Absolute path to the in-repo (or sync-published) picker binary for this
# checkout. Callers pass their scripts/runtime directory as $1 when the
# default relative resolution would be wrong; otherwise omit.
picker_bin_path() {
  local runtime_dir="${1:-}"
  local repo_root
  if [[ -n "$runtime_dir" ]]; then
    repo_root="$(cd "$runtime_dir/../.." && pwd)"
  else
    local self_dir
    self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    repo_root="$(cd "$self_dir/../.." && pwd)"
  fi
  printf '%s\n' "$repo_root/native/picker/bin/picker"
}

picker_bin_available() {
  local path="${1:-}"
  [[ -n "$path" && -x "$path" ]]
}

# Escape hatch for emergency bash / display-menu fallbacks.
picker_bin_bash_fallback_allowed() {
  case "${WEZTERM_ALLOW_BASH_PICKER:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

picker_bin_missing_toast() {
  local panel="${1:-picker}"
  tmux display-message -d 5000 \
    "Picker binary missing for ${panel}. Re-run: skills/wezterm-runtime-sync/scripts/sync-runtime.sh (or set WEZTERM_ALLOW_BASH_PICKER=1)"
}

# picker_bin_require <runtime_dir> <panel_name>
# Prints absolute binary path on stdout when present.
# Exit 0: path printed, binary usable.
# Exit 1: missing and bash fallback NOT allowed (toast already shown).
# Exit 2: missing but bash fallback allowed (caller should take bash path).
picker_bin_require() {
  local runtime_dir="${1:-}"
  local panel="${2:-popup}"
  local path
  path="$(picker_bin_path "$runtime_dir")"
  if picker_bin_available "$path"; then
    printf '%s\n' "$path"
    return 0
  fi
  if picker_bin_bash_fallback_allowed; then
    return 2
  fi
  picker_bin_missing_toast "$panel"
  return 1
}
