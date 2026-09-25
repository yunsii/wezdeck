#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
check="$repo_root/scripts/dev/check-rime-commit-counter.sh"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/wezdeck-rime-check.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

output="$(WEZDECK_RIME_USER_DIR="$tmp/missing" "$check")"
grep -q 'status=not-detected' <<<"$output"

rime="$tmp/Rime"
mkdir -p "$rime/lua" "$rime/build"
if WEZDECK_RIME_USER_DIR="$rime" "$check" >"$tmp/missing.out" 2>&1; then
  echo 'expected missing counter check to warn' >&2
  exit 1
fi
grep -q 'status=warning' "$tmp/missing.out"
grep -q 'rime-commit-counter/install.sh' "$tmp/missing.out"

printf '%s\n' '-- counter module' > "$rime/lua/wezdeck_commit_counter.lua"
printf '%s\n' '  engine/processors/@before 0: lua_processor@*wezdeck_commit_counter' > \
  "$rime/double_pinyin_flypy.custom.yaml"
output="$(WEZDECK_RIME_USER_DIR="$rime" "$check")"
grep -q 'status=healthy' <<<"$output"

echo 'test_check_rime_commit_counter: ok'
