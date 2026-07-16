#!/usr/bin/env bash
# managed-shell-lib.sh — resolve the login shell for managed panes.
#
# Shared by open-project-session, primary-pane-wrapper, run-managed-command,
# open-default-shell-session, and tmux-reset/common so shell preference stays
# in one place. Order:
#   1. WEZTERM_MANAGED_SHELL (explicit override, must be executable)
#   2. $SHELL (user's interactive shell, must be executable)
#   3. Common absolute candidates (zsh → bash → sh)
#   4. /bin/sh
#
# Sourced only — not executed as a standalone script.
# shellcheck shell=bash

if [[ -n "${__MANAGED_SHELL_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__MANAGED_SHELL_LIB_LOADED=1

resolve_login_shell() {
  if [[ -n "${WEZTERM_MANAGED_SHELL:-}" && -x "${WEZTERM_MANAGED_SHELL:-}" ]]; then
    printf '%s\n' "$WEZTERM_MANAGED_SHELL"
    return 0
  fi

  if [[ -n "${SHELL:-}" && -x "${SHELL:-}" ]]; then
    printf '%s\n' "$SHELL"
    return 0
  fi

  local candidate
  for candidate in /bin/zsh /usr/bin/zsh /bin/bash /usr/bin/bash /bin/sh /usr/bin/sh; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '/bin/sh\n'
}
