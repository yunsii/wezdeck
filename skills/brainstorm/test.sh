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
tmpj="$(mktemp)"; tmp4="$(mktemp)"; tmpbig="$(mktemp)"
trap 'rm -f "$tmpj" "$tmp4" "$tmpbig"' EXIT
"$here/run.sh" "y" --personas 2 --json >"$tmpj" 2>/dev/null
check "--json is valid JSON"    jq -e . "$tmpj"
check "--json has ideas[]"      jq -e '.ideas | length > 0' "$tmpj"
check "--json has synthesis"    jq -e 'has("synthesis")' "$tmpj"

# 4. THE FULL persona set (no --personas), because lens names are not
#    filename-safe: "Contrarian / First-Principles" carries a "/" and spaces.
#    Cases 1-3 all pinned --personas 1|2 and never reached the 4th lens, so a
#    broken temp path / fanout job label there stayed invisible.
#    Assert against the run's own `personas` count, not personas.conf's line
#    count: run.sh defaults to 4 lenses and only clamps *down* to the conf, so a
#    5th line would fail this check without anything being broken.
"$here/run.sh" "how to focus better" --json >"$tmp4" 2>/dev/null; rc4=$?
check "full persona set exits 0"  test "$rc4" -eq 0
check "every lens ingested (names with '/' and spaces)" \
  jq -e '(.ideas | map(.persona) | unique | length) == .personas' "$tmp4"

# 5. MOCK-only: a real-sized payload, sized past BOTH size cliffs:
#      64KiB  pipe buffer  — `printf … | head -n1` SIGPIPEs (rc 141) and set -e
#                            + pipefail kills the stage
#     128KiB  argv cap     — `jq --argjson <big>` dies E2BIG (rc 126)
#    The tightest site is the CUMULATIVE diverge ingest merge, which only holds
#    (n_lens-1) personas' worth when it merges the last one. So the pad must
#    satisfy (n_lens-1) * 2 ideas * pad > 128KiB — at 4 lenses, 20000 gives only
#    ~120KiB and stays green while the bug is live. 30000 gives ~180KiB.
#    More lenses only make it larger, so this stays valid as personas.conf grows.
if [ "$live" -eq 0 ]; then
  PROVIDER_MOCK_PAD_BYTES=30000 "$here/run.sh" "big payload" --json \
    >"$tmpbig" 2>/dev/null; rcb=$?
  check "oversized payload exits 0 (no SIGPIPE mid-stage)" test "$rcb" -eq 0
  check "oversized payload keeps every idea" \
    jq -e '(.ideas | length) == (.personas * 2)' "$tmpbig"
  check "oversized payload still reaches converge" \
    jq -e '(.synthesis | type) == "string" and (.synthesis | length) > 0' "$tmpbig"
fi

echo "---"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
