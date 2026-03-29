#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

cwd="${1:-$PWD}"

if [[ ! -d "$cwd" ]]; then
  cwd="$PWD"
fi

repo_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
label="$(basename "${repo_root:-$cwd}")"

style 'fg=#3f5f94,bold' "$label"
