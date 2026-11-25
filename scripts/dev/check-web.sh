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

# --fix-catalogs (the pre-commit gate): re-extract the Lingui catalogs first
# and stage them when they changed — usually only source line refs moved,
# which used to fail the commit (`i18n:check` sync) and cost a second commit
# or a blocked release. A new message still fails below until translated.
if [[ "${1:-}" == --fix-catalogs ]]; then
  catalogs=(src/locales/*/messages.po)
  before="$(cat "${catalogs[@]}" | sha1sum)"
  if corepack pnpm exec lingui extract >"$logs/extract.log" 2>&1; then
    if [[ "$(cat "${catalogs[@]}" | sha1sum)" != "$before" ]]; then
      # from the repo root with web/ paths: a hook in a linked worktree runs
      # with GIT_DIR set and no GIT_WORK_TREE, so git takes the cwd (web/)
      # as the top level and a relative add lands at the root —
      # src/locales/*.po, 3.6k lines each, went into a commit (2026-11-25)
      git -C "$repo_root" add -- "${catalogs[@]/#/web/}"
      printf '[web-check] i18n catalogs refreshed and staged\n'
    fi
  else
    printf '[web-check] lingui extract FAILED\n' >&2
    sed 's/^/  /' "$logs/extract.log" >&2
    exit 1
  fi
fi

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
