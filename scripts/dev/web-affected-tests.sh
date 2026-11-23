#!/usr/bin/env bash
# Run only the tests a change can break, instead of every suite every time.
#
#   scripts/dev/web-affected-tests.sh [--base REF] [--run] [FILE...]
#
# Changed files: the FILEs given, else the uncommitted edits (tracked and
# new), plus REF..HEAD with --base (the release passes @{u}: what is about to
# be pushed). Prints the plan; --run executes it:
#   go    `go test ./...` in native/wezdeck-wsl when its Go sources changed
#   unit  `vitest related` on the changed web files (the import graph decides)
#   cdp   the browser tests whose `// covers:` header lines (repo-relative
#         globs, `*` crosses `/`) match a changed file; ALL of them when a
#         shared file changed (SHARED below) or a web source / relay file is
#         covered by no test — an unmapped file is a gap, not a pass. Runs
#         against the local test stack (remote-test-stack.sh ensure: reused
#         when it already serves these sources).
# Not a trigger on their own: locales (the source change that moved the
# text selects its tests), docs, unit test files (unit only), Go tests.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

base=''
run=0
files=()
while (($#)); do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --run) run=1; shift ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) files+=("$1"); shift ;;
  esac
done

if ((${#files[@]} == 0)); then
  mapfile -t files < <(
    {
      git diff --name-only HEAD
      git ls-files -o --exclude-standard
      [[ -n "$base" ]] && git diff --name-only "$base..HEAD"
    } | sort -u
  )
fi

# a change here reaches every page: the shell, routing, transport, build
SHARED=(
  'web/src/lib/*' 'web/src/components/*' 'web/src/routes/*' 'web/src/styles/*'
  'web/src/styles.css' 'web/src/relay/*' 'web/src/server.ts' 'web/src/router.tsx'
  'web/src/route-tree.tsx' 'web/src/routeTree.gen.ts' 'web/src/locale-redirect.ts'
  'web/src/features/console-data.tsx' 'web/src/features/console-shared.tsx'
  'web/src/features/console-mode.ts' 'web/package.json' 'web/pnpm-lock.yaml'
  'web/vite.config.ts' 'web/wrangler.*' 'web/tsconfig.json' 'web/index.html'
  'web/tests/version.setup.ts' 'web/vitest.cdp.config.ts'
  'native/wezdeck-wsl/main.go' 'native/wezdeck-wsl/relay.go'
  'native/wezdeck-wsl/relay_parts.go' 'native/wezdeck-wsl/frame.go'
  'native/wezdeck-wsl/serve.go' 'native/wezdeck-wsl/nonce_store.go'
  'native/wezdeck-wsl/version.go' 'native/wezdeck-wsl/go.mod'
)
matches() { # FILE GLOB...
  local f="$1" g
  shift
  for g in "$@"; do
    # shellcheck disable=SC2053 # the glob is meant to match
    [[ "$f" == $g ]] && return 0
  done
  return 1
}

declare -A covers=()
for t in web/tests/*.cdp.test.ts; do
  covers[$t]="$(sed -n 's#^// covers:##p' "$t" | tr '\n' ' ')"
done

go=0
unit=()
cdp_all=''
declare -A cdp=()
for f in "${files[@]}"; do
  case "$f" in
    web/src/locales/* | *.md) continue ;;
    native/wezdeck-wsl/*_test.go) go=1; continue ;;
    native/wezdeck-wsl/*.go | native/wezdeck-wsl/go.*) go=1 ;;
    web/tests/*.unit.test.ts) unit+=("${f#web/}"); continue ;;
    web/tests/*.cdp.test.ts) cdp[$f]=1; continue ;;
    web/*) unit+=("${f#web/}") ;;
    *) continue ;;
  esac
  if matches "$f" "${SHARED[@]}"; then
    cdp_all="${cdp_all:-shared $f}"
    continue
  fi
  hit=0
  for t in "${!covers[@]}"; do
    # shellcheck disable=SC2086 # the header is a list of globs
    if matches "$f" ${covers[$t]}; then cdp[$t]=1; hit=1; fi
  done
  # only sources can be unmapped; assets / config without a test stay quiet
  if ((hit == 0)) && [[ "$f" == web/src/* || "$f" == native/wezdeck-wsl/*.go ]]; then
    cdp_all="${cdp_all:-unmapped $f}"
  fi
done

if [[ -n "$cdp_all" ]]; then
  mapfile -t selected < <(printf '%s\n' web/tests/*.cdp.test.ts)
else
  mapfile -t selected < <(printf '%s\n' "${!cdp[@]}" | sed '/^$/d' | sort)
fi

echo "changed: ${#files[@]} file(s)"
echo "go:   $( ((go)) && echo 'go test ./... (native/wezdeck-wsl)' || echo none)"
echo "unit: $( ((${#unit[@]})) && echo "vitest related (${#unit[@]} file(s))" || echo none)"
if [[ -n "$cdp_all" ]]; then
  echo "cdp:  all ${#selected[@]} ($cdp_all)"
elif ((${#selected[@]})); then
  echo "cdp:  ${selected[*]#web/}"
else
  echo "cdp:  none"
fi
((run)) || exit 0

if ((go)); then
  (cd native/wezdeck-wsl && PATH="$HOME/.local/go/bin:$PATH" go test ./...)
fi
if ((${#unit[@]})); then
  (cd web && corepack pnpm exec vitest related --run --config vitest.unit.config.ts \
    --passWithNoTests "${unit[@]}")
fi
if ((${#selected[@]})); then
  env_lines="$(scripts/dev/remote-test-stack.sh ensure | grep '^export ')"
  eval "$env_lines"
  rel=()
  for t in "${selected[@]}"; do rel+=("${t#web/}"); done
  (cd web && corepack pnpm exec vitest run --config vitest.cdp.config.ts "${rel[@]}")
fi
