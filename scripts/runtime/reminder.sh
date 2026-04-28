#!/usr/bin/env bash
# Pop a reminder popup on the most recently active tmux client.
#
# Thin domain wrapper over tmux-popup-active.sh: builds the standard
# popup body (centered message line + "回车 / Esc 关闭" hint) so callers
# only specify the message. The popup blocks until the user presses a
# key — no auto-dismiss timeout, by design: a missed reminder defeats
# the purpose.
#
# Usage: reminder.sh <title> <message> [width] [height]
#
# Designed for cron entries; no-ops silently when no tmux client is
# attached.
set -euo pipefail

if (($# < 2)); then
  echo "usage: $(basename "$0") <title> <message> [width] [height]" >&2
  exit 64
fi

title=$1
message=$2
width=${3:-50}
height=${4:-7}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build the popup body. `printf '%q'` quotes the message safely so any
# spaces/quotes/backslashes survive into the inner shell. `< /dev/tty`
# forces read to bind to the popup's own pty rather than whatever
# (potentially closed) stdin the caller had. `read -n1 -s` accepts any
# single key (Enter / Esc / etc.) so the popup is dismissible without
# committing to a specific keystroke; no `-t`, so it blocks until the
# user actually acknowledges the reminder.
body="printf '\n        %s\n\n        回车 / Esc 关闭\n' $(printf '%q' "$message"); read -n1 -s _ < /dev/tty"

exec "$script_dir/tmux-popup-active.sh" "$title" "$body" "$width" "$height"
