#!/usr/bin/env bash
# OPPO 互联 remote-control link quality from the vendor's own host logs.
#
#   bin/oppo-remote-quality.sh report [--days N] [--json]
#   bin/oppo-remote-quality.sh timeline [SESSION] [--bucket SEC]
#   bin/oppo-remote-quality.sh watch [--keys]
#   bin/oppo-remote-quality.sh episodes [--days N]   # daemon-recorded stalls + blame
#   bin/oppo-remote-quality.sh status                # current OppoRemote· badge JSON
#   bin/oppo-remote-quality.sh daemon                # systemd producer (bin/install.sh)
#
# Reads only vendor logs (daemon writes its own status.json). Log dir: %APPDATA%\O+Connect\devicespace (override with
# WEZTERM_OPPO_LOG_DIR). Docs: docs/oppo.md#link-quality-probe
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

need_sdk() {
  if [[ -z "${WEZDECK_REPO:-}" || ! -f "$WEZDECK_REPO/scripts/runtime/windows-runtime-paths-lib.sh" ]]; then
    printf 'oppo-remote-quality: set WEZTERM_OPPO_LOG_DIR / WEZTERM_OPPO_STATUS_FILE, or WEZDECK_REPO to the WezDeck checkout\n' >&2
    exit 1
  fi
}

log_dir="${WEZTERM_OPPO_LOG_DIR:-}"
if [[ -z "$log_dir" ]]; then
  need_sdk
  # shellcheck disable=SC1091
  . "$WEZDECK_REPO/scripts/runtime/windows-runtime-paths-lib.sh"
  windows_runtime_detect_paths || { echo "oppo-remote-quality: cannot resolve Windows paths; set WEZTERM_OPPO_LOG_DIR" >&2; exit 1; }
  log_dir="$WINDOWS_USERPROFILE_WSL/AppData/Roaming/O+Connect/devicespace"
fi

status_file="${WEZTERM_OPPO_STATUS_FILE:-}"
if [[ -z "$status_file" ]]; then
  need_sdk
  # shellcheck disable=SC1091
  . "$WEZDECK_REPO/scripts/runtime/windows-runtime-paths-lib.sh"
  windows_runtime_detect_paths >/dev/null 2>&1 || true
  status_file="${WINDOWS_RUNTIME_STATE_WSL:-${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime}/state/oppo-remote/status.json"
fi

[[ $# -gt 0 ]] || set -- report
case "$1" in
  daemon|episodes) set -- "$@" --status-file "$status_file" ;;
  status) cat "$status_file" 2>/dev/null && echo || echo "no status yet: $status_file"; exit 0 ;;
esac
exec python3 "$script_dir/oppo-remote-quality.py" --log-dir "$log_dir" "$@"
