#!/usr/bin/env bash
# Thin wrapper around `tmux display-popup` that raises a boolean flag for
# the overlay lifetime.
#
# Why: copy-mode auto-refresh (`refresh-from-pane`) racing a popup
# composite garbles double-width CJK cells into the overlay. While
# `@wezterm_popup_active=1`, `tmux-copy-mode-auto-refresh.sh` skips
# ticks. Flag is server-global (one default socket, many sessions) —
# any popup pauses every pane's auto-refresh for a few seconds. That
# is intentional and cheap; do not grow a refcount or session map.
#
# Usage: same args as `tmux display-popup`.
#   bash tmux-display-popup.sh -x C -y C -w 70% -h 75% -T 'Title' -E 'cmd'
#
# Callers that used to `exec tmux display-popup ...` should `exec` this
# script instead. The wrapper itself must NOT exec away from bash
# before display-popup returns — the EXIT trap has to clear the flag.
# `tmux display-popup -C` from another process closes the overlay and
# exits this process, which also fires the trap.
#
# Cooperative: every runtime open path must go through this file.
# `scripts/dev/check-display-popup-guard.sh` fails the tree if a bare
# `tmux display-popup` (non -C) appears outside this wrapper.
set -euo pipefail

# Best-effort: never fail the popup because the mark could not be set.
tmux set-option -g @wezterm_popup_active 1 2>/dev/null || true
# Drop the retired refcount option if an older build left it behind.
tmux set-option -gu @wezterm_popup_active_count 2>/dev/null || true
trap 'tmux set-option -gu @wezterm_popup_active 2>/dev/null || true' EXIT

tmux display-popup "$@"
