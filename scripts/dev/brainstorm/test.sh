#!/usr/bin/env bash
# test.sh — offline smoke test for the brainstorm runner.
#
# Default: PROVIDER_MOCK=1 — NO LLM calls. Fast, free, deterministic; exercises
# the shell logic (arg parsing, provider selection, JSON passing, jq filters,
# per-persona/per-stage fallback, converge merge, report/json output).
# Pass --live to run against real providers instead (slow, costs tokens).
#
# Exit: 0 all pass, 1 any fail.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
live=0; [ "${1:-}" = "--live" ] && live=1
[ "$live" -eq 0 ] && export PROVIDER_MOCK=1

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){ local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }

echo "brainstorm test ($([ "$live" -eq 1 ] && echo LIVE || echo MOCK))"

# 1. normal run exits 0 and reports a synthesis
out="$("$here/run.sh" "how to focus better" --personas 2 --top 2 2>/dev/null)"; rc=$?
check "normal run exits 0"      test "$rc" -eq 0
check "report includes synthesis" grep -q "synthesis" <<<"$out"
check "report includes an idea"   grep -qE '/10' <<<"$out"

# 2. single persona must not fail the whole run (per-persona fallback path)
"$here/run.sh" "x" --personas 1 >/dev/null 2>&1
check "personas=1 exits 0"      test "$?" -eq 0

# 3. --json is valid and carries a non-empty ideas array (no ideas silently dropped)
tmpj="$(mktemp)"; trap 'rm -f "$tmpj"' EXIT
"$here/run.sh" "y" --personas 2 --json >"$tmpj" 2>/dev/null
check "--json is valid JSON"    jq -e . "$tmpj"
check "--json has ideas[]"      jq -e '.ideas | length > 0' "$tmpj"
check "--json has synthesis"    jq -e 'has("synthesis")' "$tmpj"

echo "---"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
