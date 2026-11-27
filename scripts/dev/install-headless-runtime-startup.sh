#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/runtime/windows-shell-lib.sh"
: "${WSL_DISTRO_NAME:?Run this installer from the target WSL distribution}"

windows_run_powershell_script_utf8 \
  "$(wslpath -w "$repo_root/scripts/dev/install-headless-runtime-startup.ps1")" \
  -Distro "$WSL_DISTRO_NAME"
