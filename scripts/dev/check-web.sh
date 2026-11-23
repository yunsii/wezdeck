#!/usr/bin/env bash
# Validate the WezDeck web console without starting a server. The checks are
# independent, so they run concurrently (15 s serial → the slowest one); each
# writes its own log, printed only when it fails.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
web_root="$repo_root/web"

[[ -f "$web_root/package.json" ]] || {
  printf '[web-check] package.json missing: %s\n' "$web_root" >&2
  exit 1
}

logs="$(mktemp -d)"
trap 'rm -rf "$logs"' EXIT
cd "$web_root" || exit 1

declare -A checks=(
  [formatting]='corepack pnpm exec prettier --check .'
  [lint]='corepack pnpm exec eslint'
  [typecheck]='corepack pnpm exec tsc --noEmit'
  [typecheck-worker]='corepack pnpm exec tsc --noEmit -p tsconfig.worker.json'
  [i18n]='corepack pnpm run -s i18n:check'
)
declare -A pids
start=$SECONDS
for name in "${!checks[@]}"; do
  bash -c "${checks[$name]}" >"$logs/$name.log" 2>&1 &
  pids[$name]=$!
done

failed=()
for name in formatting lint typecheck typecheck-worker i18n; do
  wait "${pids[$name]}" || failed+=("$name")
done
if ((${#failed[@]})); then
  for name in "${failed[@]}"; do
    printf '[web-check] %s FAILED\n' "$name" >&2
    sed 's/^/  /' "$logs/$name.log" >&2
  done
  exit 1
fi
printf '[web-check] formatting, lint, typecheck, i18n ok (%ss, concurrent)\n' "$((SECONDS - start))"
