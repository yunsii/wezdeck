#!/usr/bin/env bash
# Run an interactive agent's resume command and fall back to a fresh session.

set -euo pipefail

agent="${1:?missing agent}"
fallback_log="${2:?missing fallback log}"
agent_bin="${3:?missing agent binary}"
mode="${4:-base}"
shift 4

"$agent_bin" "$@" --continue || {
  bash "$fallback_log" "$agent"
  printf '\033[2J\033[H\n\n  \033[2;36mLoading %s ...\033[0m\n  \033[2;36mMode: %s\033[0m\n' \
    "$agent" "$mode"
  exec "$agent_bin" "$@"
}
