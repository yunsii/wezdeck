#!/usr/bin/env bash
# Explicitly stop the Windows helper manager. The next WezTerm/helper ensure
# recreates it; this command exists for canary cleanup and operator recovery.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/windows-shell-lib.sh"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"

mode="live"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --canary) mode="canary"; shift ;;
    --all) mode="all"; shift ;;
    -h|--help)
      printf 'usage: %s [--canary|--all]\n' "$0"
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

windows_runtime_detect_paths || {
  printf 'stop-wezdeck-runtime: Windows runtime paths unavailable\n' >&2
  exit 1
}

script_win="$(wslpath -w "$repo_root/scripts/dev/stop-wezdeck-runtime.ps1")"
args=()
case "$mode" in
  live)
    args+=("-StatePath" "$WINDOWS_HELPER_STATE_WIN")
    ;;
  canary)
    args+=(
      "-StatePath" "${WINDOWS_RUNTIME_STATE_WIN}\\canary\\state\\helper\\state.env"
      "-StatePath2" "${WINDOWS_RUNTIME_STATE_WIN}\\canary\\canary\\state\\helper\\state.env"
    )
    ;;
  all)
    args+=("-All")
    ;;
esac

windows_run_powershell_script_utf8 "$script_win" "${args[@]}"
