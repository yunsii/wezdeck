#!/usr/bin/env bash
# Offline smoke for agent-fanout (PROVIDER_MOCK=1 by default).
# --live hits real backends.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
live=0
[ "${1:-}" = "--live" ] && live=1
[ "$live" -eq 0 ] && export PROVIDER_MOCK=1

pass=0; fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() {
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}

echo "agent-fanout test ($([ "$live" -eq 1 ] && echo LIVE || echo MOCK))"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/agent-fanout-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# shellcheck source=/dev/null
. "$here/lib/fanout-lib.sh"
check "fanout_call defined" declare -F fanout_call
check "fanout_run defined" declare -F fanout_run
check "fanout_run_jobs defined" declare -F fanout_run_jobs

# provider is loaded; agent_text must NOT require fanout for single-shot
check "run.sh executable" test -x "$here/run.sh"
"$here/run.sh" --help >/dev/null 2>&1
check "--help exits 0" test $? -eq 0

# thin call: no out dir required
body="$(fanout_call --backend claude --prompt "hello single" 2>/dev/null)"
check "fanout_call stdout non-empty" test -n "$body"

# dry-run multi
out="$("$here/run.sh" run --prompt "ping" --dry-run --json 2>/dev/null)"
check "dry-run json" jq -e '.dry_run == true and (.backends|length>=1)' <<<"$out"

# N=1 run still writes out (multi API) but works
out_dir="$tmp/single"
fanout_run --backend codex --prompt "one" --out "$out_dir" >/dev/null 2>&1
check "fanout_run N=1 ok" jq -e '.overall=="ok" and .counts.ok==1' "$out_dir/summary.json"

# parallel multi
out_dir="$tmp/parallel"
"$here/run.sh" run --prompt "hello" --out "$out_dir" --backends claude,codex,grok >/dev/null 2>&1
check "parallel multi ok" jq -e '.overall=="ok" and .counts.ok>=1' "$out_dir/summary.json"
check "shared prompt.md only once" test -f "$out_dir/prompt.md"

# jobs
printf 'ja\n' >"$tmp/ja.md"
printf 'jb\n' >"$tmp/jb.md"
out_dir="$tmp/jobs"
"$here/run.sh" jobs --out "$out_dir" \
  --job "alpha|claude|$tmp/ja.md" \
  --job "beta|codex|$tmp/jb.md" >/dev/null 2>&1
check "jobs ok" jq -e '.counts.ok>=2' "$out_dir/summary.json"
check "jobs stems" test -s "$out_dir/alpha.md" -a -s "$out_dir/beta.md"

# diverge path mock uses provider fixture (path contains diverge)
printf '%s\n' 'x' >"$tmp/diverge-x.full.md"
# minimal assembled shape
{
  echo "# diverge template stub"
  echo
  echo "=== INPUT ==="
  echo "persona bits"
} >"$tmp/diverge-x.full.md"
out_dir="$tmp/divjob"
fanout_run_jobs --out "$out_dir" --job "p1|claude|$tmp/diverge-x.full.md" >/dev/null 2>&1
check "diverge-path mock is JSON array" jq -e 'type=="array" and length>0' "$out_dir/p1.md"

# agent_text still direct (mock via provider basename)
diverge_pf="$here/../brainstorm/prompts/diverge.md"
got="$(printf '=== PROBLEM ===\nx\n' | run_agent claude "$diverge_pf" 2>/dev/null)"
check "run_agent mock ideas" jq -e 'type=="array" and length>0' <<<"$got"

# provider does not auto-load fanout when sourced alone
# (we already loaded fanout; spawn clean shell)
clean="$(bash -c '
  set -euo pipefail
  . "'"$here"'/../adversarial-review/lib/provider.sh"
  if declare -F fanout_call >/dev/null 2>&1; then echo LOADED; else echo CLEAN; fi
')"
check "provider alone has no fanout_call" test "$clean" = "CLEAN"

# brainstorm regression
"$here/../brainstorm/test.sh" >/dev/null 2>&1
check "brainstorm mock passes" test $? -eq 0

check "providers non-empty" test "$("$here/run.sh" providers | wc -l)" -ge 1

set +e
"$here/run.sh" run --out "$tmp/nop" >/dev/null 2>&1
rc=$?
set -e
check "missing prompt fails" test "$rc" -ne 0

echo "---"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
