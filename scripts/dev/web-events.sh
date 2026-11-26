#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/runtime/windows-runtime-paths-lib.sh
. "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"
windows_runtime_detect_paths || { printf 'Windows Runtime path unavailable\n' >&2; exit 1; }
log="$WINDOWS_RUNTIME_STATE_WSL/logs/web-client.log"
relay_log="${XDG_STATE_HOME:-$HOME/.local/state}/wezdeck/logs/relay.log"
[[ -f "$log" ]] || { printf 'No local Web events yet: %s\n' "$log" >&2; exit 1; }

if [[ $# -gt 0 ]]; then
  rg -F -- "$1" "$log" "$log".[1-3] "$relay_log" 2>/dev/null || true
else
  tail -n 200 "$log"
fi
