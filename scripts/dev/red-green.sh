#!/usr/bin/env bash
# Red, then green: prove a regression test catches the bug it was written
# for. The fix's files go back to how they were at REF (default HEAD — run it
# before committing the fix; a file new since REF is moved aside), the tests
# must FAIL; the fix comes back, the same tests must PASS. A test that passes
# on the old code proves nothing (2026-11-25: the first "+1" test only
# covered a one-row tag line and passed on the broken code).
#
#   scripts/dev/red-green.sh [--base REF] --test web/tests/x.cdp.test.ts
#                            [--test …] [--go TestName] FILE...
#
# --test  a web test (unit or cdp), run through web-affected-tests.sh --run
# --go    a Go test pattern, run as `go test -run PATTERN` in native/wezdeck-wsl
# FILE    the fix (repo-relative): reverted for the red run, restored after —
#         always, also on failure or Ctrl+C
#
# Exit 0 = red then green; 1 = not red (the test misses the bug) or not
# green (the fix does not hold); 2 = usage / setup. Logs one
# `category=red_green` row per run.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
base=HEAD
tests=()
gos=()
files=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base=$2; shift 2 ;;
    --test) tests+=("$2"); shift 2 ;;
    --go) gos+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "red-green: unknown option $1" >&2; exit 2 ;;
    *) files+=("$1"); shift ;;
  esac
done
[[ ${#files[@]} -gt 0 ]] || { echo "red-green: name the fix's files" >&2; exit 2; }
[[ ${#tests[@]} -gt 0 || ${#gos[@]} -gt 0 ]] || { echo "red-green: name a --test or --go" >&2; exit 2; }
git rev-parse --verify -q "$base^{commit}" >/dev/null || { echo "red-green: no such ref $base" >&2; exit 2; }

keep="$(mktemp -d)"
restore() {
  for f in "${files[@]}"; do
    if [[ -e "$keep/$f" ]]; then
      mkdir -p "$(dirname "$f")"
      cp -p "$keep/$f" "$f"
    fi
  done
  rm -rf "$keep"
}
trap restore EXIT INT TERM

for f in "${files[@]}"; do
  [[ -e "$f" ]] || { echo "red-green: $f does not exist" >&2; exit 2; }
  mkdir -p "$keep/$(dirname "$f")"
  cp -p "$f" "$keep/$f"
done

run_tests() {
  local ok=0
  if [[ ${#tests[@]} -gt 0 ]]; then
    scripts/dev/web-affected-tests.sh --run "${tests[@]}" >"$keep/out" 2>&1 || ok=1
    grep -E "Tests |FAIL|AssertionError|TimeoutError" "$keep/out" | head -8 || true
  fi
  for pattern in "${gos[@]}"; do
    (cd native/wezdeck-wsl && PATH="$HOME/.local/go/bin:$PATH" go test -run "$pattern" ./... >"$keep/go" 2>&1) || ok=1
    tail -3 "$keep/go"
  done
  return $ok
}

echo "red-green: red — ${files[*]} as of $base"
for f in "${files[@]}"; do
  if git cat-file -e "$base:$f" 2>/dev/null; then
    git show "$base:$f" >"$f"
  else
    rm -f "$f" # new since base: the old code did not have it
  fi
done
red=fail
if run_tests; then red=pass; fi

restore
trap - EXIT INT TERM
# A source change changes the test stack fingerprint. Only stop an explicitly
# isolated stack; the default shared stack may belong to another test run.
if [[ -n "${WEZDECK_TEST_STACK_DIR:-}" && ${#tests[@]} -gt 0 ]]; then
  scripts/dev/remote-test-stack.sh stop >/dev/null
fi
keep="$(mktemp -d)" # run_tests writes its logs here
trap 'rm -rf "$keep"' EXIT

echo "red-green: green — the fix restored"
green=fail
if run_tests; then green=pass; fi

source "$repo/scripts/runtime/runtime-log-lib.sh"
runtime_log_info red_green "red-green finished" base="$base" red="$red" green="$green" \
  tests="${tests[*]:-}" go="${gos[*]:-}" files="${files[*]}" || true

if [[ $red == pass ]]; then
  echo "red-green: NOT RED — the tests pass on the old code, they do not catch the bug" >&2
  exit 1
fi
if [[ $green == fail ]]; then
  echo "red-green: NOT GREEN — the tests fail with the fix" >&2
  exit 1
fi
echo "red-green: ok — red on the old code, green with the fix"
