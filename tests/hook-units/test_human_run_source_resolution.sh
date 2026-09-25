#!/usr/bin/env bash
# human-run must resolve its repository through a user-level skill symlink.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
test_root="$(mktemp -d /tmp/wezdeck-human-run.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/home/.agents/skills"
ln -s "$repo_root/skills/human-run" "$test_root/home/.agents/skills/human-run"

output="$(
  HOME="$test_root/home" \
  WEZDECK_REPO="$repo_root" \
  "$test_root/home/.agents/skills/human-run/ensure-env.sh" 2>&1
)"

grep -Fq "ok wd_run=$repo_root/scripts/runtime/cli/wd-run" <<< "$output"
[[ "$(sed -n 's/^wd_run=//p' "$test_root/home/.wezterm-x/agent-tools.env")" == \
  "$repo_root/scripts/runtime/cli/wd-run" ]]

resolved="$(
  HOME="$test_root/home" \
  WEZDECK_REPO="$repo_root" \
  "$test_root/home/.agents/skills/human-run/lib/resolve-wd-run.sh"
)"
[[ "$resolved" == "$repo_root/scripts/runtime/cli/wd-run" ]]

printf 'PASS human-run source resolution through user-level symlink\n'
