#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/wezdeck-web-deps.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/main/web/node_modules"
git -C "$TEST_ROOT/main" init -q
printf '{"name":"web"}\n' > "$TEST_ROOT/main/web/package.json"
printf 'lockfileVersion: 9\n' > "$TEST_ROOT/main/web/pnpm-lock.yaml"
git -C "$TEST_ROOT/main" add web
git -C "$TEST_ROOT/main" -c user.name=Test -c user.email=test@example.com commit -qm init
git -C "$TEST_ROOT/main" worktree add -q -b linked "$TEST_ROOT/linked"
export WEZDECK_WEB_DEPS_PRIMARY_ROOT="$TEST_ROOT/main"
cd "$TEST_ROOT/linked"
[[ "$(bash "$ROOT/scripts/dev/web-worktree-deps.sh" check)" == ready_to_link=* ]]
bash "$ROOT/scripts/dev/web-worktree-deps.sh" link >/dev/null
[[ "$(readlink -f web/node_modules)" == "$TEST_ROOT/main/web/node_modules" ]]
bash "$ROOT/scripts/dev/web-worktree-deps.sh" link >/dev/null
printf 'other\n' >> web/pnpm-lock.yaml
if bash "$ROOT/scripts/dev/web-worktree-deps.sh" link >/dev/null 2>&1; then
  printf 'mismatched lockfile was accepted\n' >&2
  exit 1
fi
printf 'PASS web-worktree-deps\n'
