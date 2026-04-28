#!/usr/bin/env bash
# Pop a tmux display-popup on the most recently active attached client.
# Designed for cron entries (cron has no TMUX env): picks the popup
# target by sorting tmux clients on `client_activity`, so the popup
# lands on whichever session the user was last looking at. No-ops
# silently when no client is attached.
#
# Usage: tmux-popup-active.sh <title> <body-shell> [width] [height]
set -euo pipefail

if (($# < 2)); then
  echo "usage: $(basename "$0") <title> <body-shell> [width] [height]" >&2
  exit 64
fi

title=$1
body=$2
width=${3:-50}
height=${4:-9}

target=$(tmux list-clients -F '#{client_activity} #{client_session}' 2>/dev/null \
  | sort -rn | head -1 | awk '{print $2}')

[[ -n "$target" ]] || exit 0

exec tmux display-popup -E -t "$target" -w "$width" -h "$height" -T "$title" "$body"
