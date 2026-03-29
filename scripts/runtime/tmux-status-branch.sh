#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

cwd="${1:-$PWD}"

if [[ ! -d "$cwd" ]]; then
  cwd="$PWD"
fi

if ! git -C "$cwd" rev-parse --show-toplevel >/dev/null 2>&1; then
  style 'fg=#7f7a72' 'no-branch'
  exit 0
fi

branch="$(git -C "$cwd" symbolic-ref --quiet --short HEAD 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null || true)"

if [[ -n "$branch" ]]; then
  style 'fg=#7b4f96' "$branch"
else
  style 'fg=#7f7a72' 'no-branch'
fi
