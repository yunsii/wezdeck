#!/usr/bin/env bash
# Reuse the primary checkout's Web dependencies when manifests are identical.
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
PRIMARY="${WEZDECK_WEB_DEPS_PRIMARY_ROOT:-$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")}"
MODE="${1:-check}"
shift || true
WEB="$REPO/web"
SHARED="$PRIMARY/web/node_modules"

[[ -d "$WEB" && -d "$PRIMARY/web" ]] || { printf 'web checkout unavailable\n' >&2; exit 1; }
if ! cmp -s "$WEB/package.json" "$PRIMARY/web/package.json" ||
   ! cmp -s "$WEB/pnpm-lock.yaml" "$PRIMARY/web/pnpm-lock.yaml"; then
  printf 'web manifests differ from primary; install dependencies in this worktree\n' >&2
  exit 2
fi
[[ -d "$SHARED" ]] || { printf 'primary web/node_modules is missing\n' >&2; exit 1; }

case "$MODE" in
  check)
    if [[ -L "$WEB/node_modules" ]]; then
      printf 'linked=%s\n' "$(readlink -f "$WEB/node_modules")"
    elif [[ -d "$WEB/node_modules" ]]; then
      printf 'independent=%s\n' "$WEB/node_modules"
    else
      printf 'ready_to_link=%s\n' "$SHARED"
    fi
    ;;
  link)
    if [[ -L "$WEB/node_modules" && "$(readlink -f "$WEB/node_modules")" == "$(readlink -f "$SHARED")" ]]; then
      printf 'already linked=%s\n' "$SHARED"
    elif [[ -e "$WEB/node_modules" || -L "$WEB/node_modules" ]]; then
      printf 'existing web/node_modules left untouched: %s\n' "$WEB/node_modules" >&2
      exit 3
    else
      ln -s "$SHARED" "$WEB/node_modules"
      printf 'linked=%s\n' "$SHARED"
    fi
    ;;
  build|unit|dev)
    [[ -L "$WEB/node_modules" || -d "$WEB/node_modules" ]] || {
      printf 'run link first (or install dependencies locally)\n' >&2; exit 1;
    }
    cd "$WEB"
    case "$MODE" in
      build) exec pnpm exec vite build --configLoader runner "$@" ;;
      unit) exec pnpm exec vitest run --config vitest.unit.config.ts --configLoader runner "$@" ;;
      dev)
        if [[ -L "$WEB/node_modules" && "$(readlink -f "$WEB/node_modules")" == "$(readlink -f "$SHARED")" ]]; then
          export WEZDECK_WEB_SHARED_DEPS="$SHARED"
        fi
        exec pnpm exec vite dev --configLoader runner "$@"
        ;;
    esac
    ;;
  *) printf 'usage: %s check|link|build|unit|dev [args...]\n' "$0" >&2; exit 2 ;;
esac
