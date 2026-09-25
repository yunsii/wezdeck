#!/usr/bin/env bash
# Validate the WezDeck web console without starting a server.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
web_root="$repo_root/web"

[[ -f "$web_root/package.json" ]] || {
  printf '[web-check] package.json missing: %s\n' "$web_root" >&2
  exit 1
}

printf '[web-check] formatting\n'
(cd "$web_root" && corepack pnpm run check)
printf '[web-check] lint\n'
(cd "$web_root" && corepack pnpm run lint)
printf '[web-check] typecheck\n'
(cd "$web_root" && corepack pnpm run typecheck)
printf '[web-check] i18n catalogs\n'
(cd "$web_root" && corepack pnpm run i18n:check)
