#!/usr/bin/env bash
# Read-only check for the optional Rime/Weasel commit counter.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"

# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"

resolve_rime_user() {
  local candidate=""

  if [[ -n "${WEZDECK_RIME_USER_DIR:-}" ]]; then
    if [[ -d "$WEZDECK_RIME_USER_DIR" ]]; then
      printf '%s\n' "$WEZDECK_RIME_USER_DIR"
      return 0
    fi
    return 1
  fi

  for candidate in /mnt/c/Users/*/AppData/Roaming/Rime; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if windows_runtime_detect_paths; then
    candidate="$WINDOWS_USERPROFILE_WSL/AppData/Roaming/Rime"
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  return 1
}

rime_user="$(resolve_rime_user || true)"
if [[ -z "$rime_user" ]]; then
  printf '[rime-check] status=not-detected\n'
  exit 0
fi

lua_file="$rime_user/lua/wezdeck_commit_counter.lua"
schema_custom="$rime_user/double_pinyin_flypy.custom.yaml"
schema_build="$rime_user/build/double_pinyin_flypy.schema.yaml"
missing=()
[[ -f "$lua_file" ]] || missing+=("lua module")

schema_has_counter=0
for schema in "$schema_custom" "$schema_build"; do
  if [[ -f "$schema" ]] && grep -q 'wezdeck_commit_counter' "$schema"; then
    schema_has_counter=1
    break
  fi
done
(( schema_has_counter )) || missing+=("schema registration")

if ((${#missing[@]} > 0)); then
  printf '[rime-check] status=warning rime_user=%s missing=%s\n' \
    "$rime_user" "$(IFS=', '; printf '%s' "${missing[*]}")"
  printf '[rime-check] install: %s\n' \
    "$repo_root/scripts/dev/rime-commit-counter/install.sh"
  exit 1
fi

if [[ -n "${WEZDECK_RIME_STATE_DIR:-}" ]]; then
  log_file="$WEZDECK_RIME_STATE_DIR/rime-commits.jsonl"
else
  windows_profile="${rime_user%/AppData/Roaming/Rime}"
  if [[ "$windows_profile" != "$rime_user" ]]; then
    log_file="$windows_profile/AppData/Local/wezterm-runtime/state/rime-commits.jsonl"
  else
    log_file="${WINDOWS_RUNTIME_STATE_WSL:-$HOME/.local/state/wezterm-runtime}/state/rime-commits.jsonl"
  fi
fi
printf '[rime-check] status=healthy rime_user=%s log=%s\n' "$rime_user" "$log_file"
