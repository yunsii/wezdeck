#!/usr/bin/env bash
# Pop a tmux display-popup on the most recently active attached client.
# Designed for cron entries (cron has no TMUX env): picks the popup
# target by sorting tmux clients on `client_activity`, so the popup
# lands on whichever session the user was last looking at. No-ops
# silently when no client is attached.
#
# Emits two `popup` category events to runtime.log: a `warn` with
# `message="skipped"` when there is no attached client (the silent
# no-op path), and an `info` with `message="shown"` immediately
# before `exec tmux display-popup` succeeds. The `reminders` CLI
# reads these to distinguish "cron fired the CMD" from "popup
# actually reached the screen" — the gap that hid the silent
# tmux-binary mismatch bug for weeks.
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./runtime-log-lib.sh
. "$script_dir/runtime-log-lib.sh"

# `|| true` keeps `set -euo pipefail` from killing the script when
# `tmux list-clients` itself fails (e.g. version-skewed client/server,
# or no tmux server running yet) — both indistinguishable from "no
# attached client" for our purposes, and both deserve the warn-level
# ack the same way.
target=$(tmux list-clients -F '#{client_activity} #{client_session}' 2>/dev/null \
  | sort -rn | head -1 | awk '{print $2}') || true

if [[ -z "$target" ]]; then
  # Second `|| true`: a logging failure (read-only state dir in some
  # exotic test env, full disk, …) must not break the popup script's
  # exit contract — callers rely on exit 0 = "did not need to act".
  runtime_log_warn popup 'skipped' popup_outcome=no_client popup_title="$title" || true
  exit 0
fi

runtime_log_info popup 'shown' popup_target="$target" popup_title="$title" || true
exec tmux display-popup -E -t "$target" -w "$width" -h "$height" -T "$title" "$body"
