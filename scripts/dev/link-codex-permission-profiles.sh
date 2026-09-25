#!/usr/bin/env bash
# Link the tracked Codex permission overlays into CODEX_HOME.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"
source_dir="$repo_root/agent-profiles/v1/host-setup"
target_dir="${CODEX_HOME:-$HOME/.codex}"

mkdir -p "$target_dir"

for profile in auto full-access; do
  source_file="$source_dir/$profile.config.toml"
  target_file="$target_dir/$profile.config.toml"

  [[ -f "$source_file" ]] || {
    printf 'missing profile source: %s\n' "$source_file" >&2
    exit 1
  }

  if [[ -e "$target_file" && ! -L "$target_file" ]]; then
    printf 'refusing to replace regular file: %s\n' "$target_file" >&2
    exit 1
  fi

  ln -sfn "$source_file" "$target_file"
  printf 'linked %s -> %s\n' "$target_file" "$source_file"
done
