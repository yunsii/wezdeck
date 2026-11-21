#!/usr/bin/env bash
# OPPO 互联 remote-control link quality from the vendor's own host logs.
#
#   scripts/dev/oppo-remote-quality.sh report [--days N] [--json]
#   scripts/dev/oppo-remote-quality.sh timeline [SESSION] [--bucket SEC]
#   scripts/dev/oppo-remote-quality.sh watch [--keys]
#
# Read-only. Log dir: %APPDATA%\O+Connect\devicespace (override with
# WEZTERM_OPPO_LOG_DIR). Docs: docs/oppo-remote-host-input.md#link-quality-probe
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

log_dir="${WEZTERM_OPPO_LOG_DIR:-}"
if [[ -z "$log_dir" ]]; then
  # shellcheck disable=SC1091
  . "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"
  windows_runtime_detect_paths || { echo "oppo-remote-quality: cannot resolve Windows paths; set WEZTERM_OPPO_LOG_DIR" >&2; exit 1; }
  log_dir="$WINDOWS_USERPROFILE_WSL/AppData/Roaming/O+Connect/devicespace"
fi

[[ $# -gt 0 ]] || set -- report
exec python3 "$script_dir/oppo-remote-quality.py" --log-dir "$log_dir" "$@"
