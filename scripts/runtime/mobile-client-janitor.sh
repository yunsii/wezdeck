#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"

usage() {
  cat <<'EOF'
usage:
  mobile-client-janitor.sh [--dry-run|--detach] [--min-idle <duration>]

Detaches tmux clients sitting idle on m-* mirror sessions (phone attaches
created by the tm() zsh helper — see docs/mobile-access.md).

Why: closing Termux or losing the network does NOT detach the server-side
client; mosh-server keeps it alive indefinitely. As the "latest" client it
keeps sizing the shared windows at phone width, and agent TUIs then reprint
their transcript at that width, evicting full-width scrollback. Detaching
the ghost returns sizing to the desktop; the mirror session self-destructs
via its destroy-unattached option.

Desktop clients are never candidates: only clients attached to sessions
whose name starts with "m-" are considered.

Defaults:
  --dry-run
  --min-idle 15m

Duration accepts plain seconds or a suffix: s, m, h, d.
EOF
}

parse_duration_seconds() {
  local value="${1:-}"
  local number suffix

  if [[ "$value" =~ ^([0-9]+)([smhd]?)$ ]]; then
    number="${BASH_REMATCH[1]}"
    suffix="${BASH_REMATCH[2]}"
  else
    printf 'invalid duration: %s\n' "$value" >&2
    return 1
  fi

  case "$suffix" in
    ''|s) printf '%s\n' "$number" ;;
    m) printf '%s\n' "$((number * 60))" ;;
    h) printf '%s\n' "$((number * 60 * 60))" ;;
    d) printf '%s\n' "$((number * 24 * 60 * 60))" ;;
    *) return 1 ;;
  esac
}

mode="dry-run"
min_idle_raw="15m"

while (( $# > 0 )); do
  case "$1" in
    --dry-run) mode="dry-run" ;;
    --detach) mode="detach" ;;
    --min-idle)
      shift
      min_idle_raw="${1:?--min-idle requires a value}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

min_idle_seconds="$(parse_duration_seconds "$min_idle_raw")"

# The client must speak the running server's protocol; cron's PATH usually
# resolves an older tmux than the user-local build that runs the server.
TMUX_BIN="${WEZTERM_TMUX_BIN:-}"
if [[ -z "$TMUX_BIN" ]]; then
  for candidate in "$HOME/.local/bin/tmux" /usr/local/bin/tmux tmux; do
    if command -v "$candidate" >/dev/null 2>&1; then
      TMUX_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi

# No server (or no tmux at all) is a normal cron condition: exit quietly.
clients="$("$TMUX_BIN" list-clients \
  -F '#{client_tty}|#{client_session}|#{client_activity}' 2>/dev/null)" || exit 0

now="$(date +%s)"
detached=0
skipped=0

while IFS='|' read -r client_tty session_name activity; do
  [[ -n "$client_tty" ]] || continue
  [[ "$session_name" == m-* ]] || continue

  idle=$(( now - activity ))
  if (( idle < min_idle_seconds )); then
    skipped=$(( skipped + 1 ))
    continue
  fi

  if [[ "$mode" == "dry-run" ]]; then
    printf 'would detach %s (session=%s idle=%ss)\n' "$client_tty" "$session_name" "$idle"
    detached=$(( detached + 1 ))
    continue
  fi

  if "$TMUX_BIN" detach-client -t "$client_tty" 2>/dev/null; then
    runtime_log_info mobile_access "detached idle mirror client" \
      "client_tty=$client_tty" "session_name=$session_name" \
      "idle_seconds=$idle" "min_idle_seconds=$min_idle_seconds"
    detached=$(( detached + 1 ))
  else
    runtime_log_warn mobile_access "failed to detach mirror client" \
      "client_tty=$client_tty" "session_name=$session_name"
  fi
done <<< "$clients"

if [[ "$mode" == "dry-run" ]]; then
  printf 'mobile-client-janitor dry-run: %s candidate(s), %s below idle threshold\n' \
    "$detached" "$skipped"
fi
