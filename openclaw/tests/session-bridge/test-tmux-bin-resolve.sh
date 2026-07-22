#!/usr/bin/env bash
# Prefer a client that can talk to the live socket (version-match).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/lib.sh"

bin="$(sb_tmux_bin)"
[[ -x "$bin" ]] || { echo "FAIL: no bin"; exit 1; }

if sb_host_tmux_ok() { sb_tmux list-sessions >/dev/null 2>&1; }; then
  :
fi

if ! sb_tmux list-sessions >/dev/null 2>&1; then
  echo "SKIP: no reachable tmux server on $(sb_tmux_socket) (bin=$bin)"
  exit 0
fi

# Resolved bin must succeed; common system /usr/bin/tmux may fail if mismatched
if ! "$bin" -S "$(sb_tmux_socket)" list-sessions >/dev/null 2>&1; then
  echo "FAIL: resolved bin cannot list-sessions: $bin" >&2
  exit 1
fi

# If both local and system exist and differ, system-only should not be preferred when it fails
sys=/usr/bin/tmux
localb="${HOME}/.local/bin/tmux"
if [[ -x "$sys" && -x "$localb" ]]; then
  if ! "$sys" -S "$(sb_tmux_socket)" list-sessions >/dev/null 2>&1 \
     && "$localb" -S "$(sb_tmux_socket)" list-sessions >/dev/null 2>&1; then
    if [[ "$bin" != "$localb" ]]; then
      echo "FAIL: expected prefer $localb, got $bin" >&2
      exit 1
    fi
  fi
fi

echo "PASS: tmux bin resolve → $bin ($("$bin" -V 2>/dev/null || true))"
