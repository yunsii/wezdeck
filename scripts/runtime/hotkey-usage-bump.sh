#!/usr/bin/env bash
# Usage: hotkey-usage-bump.sh <hotkey_id>
#
# Increment the aggregate counter for <hotkey_id> in the shared JSON counter
# file. Atomic: flock on a sibling .lock plus jq read-modify-write with
# tmpfile + rename. Best-effort — silently no-op when jq/flock are missing
# or input is malformed, so a bump failure never disrupts a keypress path.
#
# File layout (versioned via `schema_version`):
#   {
#     "schema_version": 1,
#     "updated_at": "<ISO8601 UTC>",
#     "hotkeys": {
#       "<hotkey_id>": {
#         "count":      <int>,
#         "first_seen": "<ISO8601 UTC>",
#         "last_seen":  "<ISO8601 UTC>"
#       }
#     }
#   }

set -u

hotkey_id="${1:-}"
[[ -n "$hotkey_id" ]] || exit 0

command -v jq >/dev/null 2>&1 || exit 0
command -v flock >/dev/null 2>&1 || exit 0

lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$lib_dir/windows-runtime-paths-lib.sh"

hotkey_usage_path() {
  if windows_runtime_detect_paths 2>/dev/null; then
    printf '%s/hotkey-usage.json' "$WINDOWS_RUNTIME_STATE_WSL"
    return 0
  fi
  local state_root="${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime"
  printf '%s/hotkey-usage.json' "$state_root"
}

file_path="$(hotkey_usage_path)"
dir="${file_path%/*}"
mkdir -p "$dir" 2>/dev/null || exit 0
[[ -f "$file_path" ]] || printf '%s\n' '{"schema_version":1,"hotkeys":{}}' > "$file_path"

lock="${file_path}.lock"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

(
  flock -x 9 || exit 0
  tmp="${file_path}.tmp.$$"
  if jq \
       --arg id "$hotkey_id" \
       --arg now "$now" \
       '
         .schema_version = 1
         | .updated_at = $now
         | .hotkeys[$id].count = ((.hotkeys[$id].count // 0) + 1)
         | .hotkeys[$id].first_seen = (.hotkeys[$id].first_seen // $now)
         | .hotkeys[$id].last_seen = $now
       ' \
       "$file_path" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$file_path"
  else
    rm -f "$tmp"
  fi
) 9>"$lock"
