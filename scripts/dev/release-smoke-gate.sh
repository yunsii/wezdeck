#!/usr/bin/env bash
# L0 pre-deploy core capability smoke gate for wezdeck-release.sh.
#
# Verifies that the freshly built web/dist + native/wezdeck-wsl binary can
# boot, connect over HostRelay, authorize, read sessions, send messages, and
# answer interactive prompts — BEFORE touching production Cloudflare or
# restarting live wezdeck-relay.
#
#   scripts/dev/release-smoke-gate.sh [--go] [--web]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

check_go=0
check_web=0
while (($#)); do
  case "$1" in
    --go) check_go=1; shift ;;
    --web) check_web=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "smoke-gate: unknown argument: $1" >&2; exit 2 ;;
  esac
done
if ((check_go == 0 && check_web == 0)); then
  check_go=1
  check_web=1
fi

echo "::phase:: L0 static checks (vet / architecture contract / dist assets)"
if ((check_go)); then
  (cd native/wezdeck-wsl && PATH="$HOME/.local/go/bin:$PATH" go vet ./...)
fi
if ((check_web)); then
  (cd web && corepack pnpm exec vitest run --config vitest.unit.config.ts tests/architecture.unit.test.ts)
  [[ -f web/dist/client/build.json ]] || { echo "smoke-gate: web/dist/client/build.json missing" >&2; exit 1; }
  js_count="$(find web/dist/client/assets -maxdepth 1 -name '*.js' 2>/dev/null | wc -l)"
  ((js_count > 0)) || { echo "smoke-gate: no built JS assets in web/dist/client/assets" >&2; exit 1; }
fi

# Dedicated isolated test stack so the release gate never collides with a dev :3018 stack.
SMOKE_DIR="${WEZDECK_RELEASE_SMOKE_DIR:-${TMPDIR:-/tmp}/wezdeck-release-smoke-stack}"
SMOKE_PORT="${WEZDECK_RELEASE_SMOKE_PORT:-3019}"
cleanup() {
  WEZDECK_TEST_STACK_DIR="$SMOKE_DIR" WEZDECK_TEST_STACK_PORT="$SMOKE_PORT" \
    scripts/dev/remote-test-stack.sh stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "::phase:: starting isolated smoke stack on :$SMOKE_PORT"
# Ensure dev-vars tokens exist in linked worktrees and in the built server dir.
if [[ ! -f web/.dev.vars ]]; then
  primary=''
  IFS= read -r -d '' primary < <(git worktree list --porcelain -z)
  primary="${primary#worktree }"
  if [[ -n "$primary" && -f "$primary/web/.dev.vars" ]]; then
    cp -f "$primary/web/.dev.vars" web/.dev.vars
  else
    printf 'RELAY_HOST_TOKEN=dev-host-token\nRELAY_CLIENT_TOKEN=dev-client-token\n' >web/.dev.vars
  fi
fi
if [[ -d web/dist/server && ! -f web/dist/server/.dev.vars ]]; then
  cp -f web/.dev.vars web/dist/server/.dev.vars
fi
if [[ -d web/dist/wezdeck_relay_do && ! -f web/dist/wezdeck_relay_do/.dev.vars ]]; then
  cp -f web/.dev.vars web/dist/wezdeck_relay_do/.dev.vars
fi
env_lines="$(WEZDECK_TEST_STACK_DIR="$SMOKE_DIR" WEZDECK_TEST_STACK_PORT="$SMOKE_PORT" \
  scripts/dev/remote-test-stack.sh start | grep '^export ')"
eval "$env_lines"

echo "::phase:: running smoke-core.cdp.test.ts"
log="$(mktemp)"
rc=0
if ! (cd web && corepack pnpm exec vitest run --config vitest.cdp.config.ts tests/smoke-core.cdp.test.ts) 2>&1 | tee "$log"; then
  if grep -q 'ERR_NETWORK_CHANGED' "$log"; then
    echo "::phase:: retrying smoke-core once after ERR_NETWORK_CHANGED"
    (cd web && corepack pnpm exec vitest run --config vitest.cdp.config.ts tests/smoke-core.cdp.test.ts) || rc=$?
  else
    rc=1
  fi
fi
rm -f "$log"
if ((rc != 0)); then
  echo "FAIL: L0 core availability smoke gate failed — aborting deploy"
  exit 1
fi
echo "ok: L0 core availability smoke gate passed"
