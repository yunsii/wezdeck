#!/usr/bin/env bash
# Unit tests for scripts/runtime/agent-run-lib.sh + cli/wd-run
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lib="$repo_root/scripts/runtime/agent-run-lib.sh"
wd_run="$repo_root/scripts/runtime/cli/wd-run"

pass=0
fail=0

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n    got:  %q\n    want: %q\n' "$name" "$got" "$want"
  fi
}

assert_ok() {
  local name="$1"
  shift
  if "$@"; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s (exit $?)\n' "$name"
  fi
}

assert_fail() {
  local name="$1" want_rc="$2"
  shift 2
  set +e
  "$@"
  local rc=$?
  set -e
  if [[ "$rc" -eq "$want_rc" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s (exit %s)\n' "$name" "$want_rc"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n    got exit %s want %s\n' "$name" "$rc" "$want_rc"
  fi
}

assert_contains() {
  local name="$1" hay="$2" needle="$3"
  if [[ "$hay" == *"$needle"* ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n    haystack missing %q\n' "$name" "$needle"
  fi
}

sandbox="$(mktemp -d -t agent-run-test.XXXXXX)"
trap 'rm -rf "$sandbox"' EXIT
export XDG_STATE_HOME="$sandbox/xdg"
export AGENT_RUN_ENTRY_KEEP=3
export AGENT_RUN_AUDIT_ROTATE_BYTES=200
export AGENT_RUN_AUDIT_ROTATE_COUNT=2
mkdir -p "$XDG_STATE_HOME" "$sandbox/work" "$sandbox/other"

# shellcheck disable=SC1090
source "$lib"

printf '== cwd required ==\n'
assert_fail "propose without cwd fails" 1 \
  "$wd_run" propose --actor test --stdin <<<"echo hi"

assert_fail "propose missing cwd dir fails" 1 \
  "$wd_run" propose --cwd "$sandbox/no-such" --actor test --stdin <<<"echo hi"

out="$("$wd_run" propose --cwd "$sandbox/work" --actor test --summary 't1' --stdin <<<"pwd" 2>/dev/null)"
id1="${out#id=}"
id1="$(printf '%s' "$id1" | head -n1 | tr -d '\r')"
assert_ok "propose with cwd" test -n "$id1"

head_id="$(agent_run_read_head_id)"
assert_eq "HEAD is first id" "$head_id" "$id1"

cwd_stored="$(jq -r '.session.cwd' "$(agent_run_entry_path "$id1")")"
want_cwd="$(cd "$sandbox/work" && pwd -P)"
assert_eq "cwd stored absolute" "$cwd_stored" "$want_cwd"

printf '== CAS supersede ==\n'
out="$("$wd_run" propose --cwd "$sandbox/other" --actor test --summary 't2' --stdin <<<"echo second" 2>/dev/null)"
id2="${out#id=}"
id2="$(printf '%s' "$id2" | head -n1 | tr -d '\r')"
assert_eq "HEAD is second id" "$(agent_run_read_head_id)" "$id2"

st1="$(jq -r '.status' "$(agent_run_entry_path "$id1")")"
assert_eq "old pending marked superseded" "$st1" "superseded"

set +e
"$wd_run" run --id "$id1" >/dev/null 2>&1
rc=$?
set -e
assert_eq "run old id exits superseded" "$rc" "2"

printf '== run in cwd ==\n'
marker="$sandbox/other/ran-from.txt"
out="$("$wd_run" propose --cwd "$sandbox/other" --actor test --summary 't3' --stdin <<EOF
pwd > "$marker"
EOF
2>/dev/null)"
id3="${out#id=}"
id3="$(printf '%s' "$id3" | head -n1 | tr -d '\r')"
assert_ok "run HEAD" "$wd_run" run --id "$id3"
got_pwd="$(cat "$marker")"
want_other="$(cd "$sandbox/other" && pwd -P)"
assert_eq "script ran in recorded cwd" "$got_pwd" "$want_other"

printf '== entry GC ==\n'
# ENTRY_KEEP=3; create more proposals to force prune
for i in 4 5 6 7; do
  "$wd_run" propose --cwd "$sandbox/work" --actor test --summary "t$i" --stdin <<<"echo $i" >/dev/null 2>&1
done
agent_run_ensure_dirs
count="$(find "$AGENT_RUN_ENTRIES_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
# keep at most 3 (HEAD protected)
if [[ "$count" -le 3 ]]; then
  pass=$((pass + 1))
  printf '  PASS  entry count capped (%s <= 3)\n' "$count"
else
  fail=$((fail + 1))
  printf '  FAIL  entry count %s > 3\n' "$count"
fi
assert_ok "HEAD still present" test -s "$AGENT_RUN_HEAD_FILE"

printf '== wait until human run ==\n'
out="$("$wd_run" propose --cwd "$sandbox/work" --actor test --summary 'wait-me' --stdin <<<"echo waited-ok" 2>/dev/null)"
wait_id="${out#id=}"
wait_id="$(printf '%s' "$wait_id" | head -n1 | tr -d '\r')"
# Finish the handoff in the background while wait blocks briefly
(
  sleep 0.3
  "$wd_run" run --id "$wait_id" >/dev/null 2>&1
) &
set +e
"$wd_run" wait --id "$wait_id" --timeout 10 --interval 1
wait_rc=$?
set -e
assert_eq "wait returns script exit 0" "$wait_rc" "0"

out="$("$wd_run" propose --cwd "$sandbox/work" --actor test --summary 'wait-timeout' --stdin <<<"echo never" 2>/dev/null)"
toid="${out#id=}"
toid="$(printf '%s' "$toid" | head -n1 | tr -d '\r')"
set +e
"$wd_run" wait --id "$toid" --timeout 1 --interval 1
to_rc=$?
set -e
assert_eq "wait timeout exit 124" "$to_rc" "124"

printf '== peek / format_preview (printf leading-dash regression) ==\n'
# Regression: bash printf treats a format starting with '-' as flags
# (printf '----- end -----' → "invalid option"). Under set -e that made
# peek report "entry not found" for a live pending id. Body also includes
# leading "--" lines so we exercise script dumping, not just banners.
out="$("$wd_run" propose --cwd "$sandbox/work" --actor test --summary 'peek-reg' --stdin <<'EOF' 2>/dev/null
# handoff preview regression
echo start
--not-a-flag
echo end
EOF
)"
peek_id="${out#id=}"
peek_id="$(printf '%s' "$peek_id" | head -n1 | tr -d '\r')"

set +e
preview="$(agent_run_format_preview "$peek_id" 2>&1)"
fmt_rc=$?
set -e
assert_eq "format_preview exit 0" "$fmt_rc" "0"
assert_contains "format_preview has id" "$preview" "$peek_id"
assert_contains "format_preview has end banner" "$preview" "----- end -----"
assert_contains "format_preview keeps body dash line" "$preview" "--not-a-flag"

set +e
peek_out="$("$wd_run" peek --id "$peek_id" 2>&1)"
peek_rc=$?
set -e
assert_eq "wd-run peek exit 0" "$peek_rc" "0"
assert_contains "peek output not false missing" "$peek_out" "$peek_id"
case "$peek_out" in
  *"entry not found"*)
    fail=$((fail + 1))
    printf '  FAIL  peek falsely reported entry not found\n'
    ;;
  *)
    pass=$((pass + 1))
    printf '  PASS  peek does not claim missing entry\n'
    ;;
esac

printf '== audit rotate ==\n'
# Pad audit file past rotate threshold
agent_run_ensure_dirs
while [[ "$(wc -c <"$AGENT_RUN_AUDIT_FILE" | tr -d ' ')" -lt 250 ]]; do
  agent_run_audit "peek" "pad" "test" "ok" "padding-for-rotate-test" "x"
done
before="$(wc -c <"$AGENT_RUN_AUDIT_FILE" | tr -d ' ')"
agent_run_audit_rotate_if_needed
if [[ -f "${AGENT_RUN_AUDIT_FILE}.1" ]]; then
  pass=$((pass + 1))
  printf '  PASS  audit rotated to .1 (before=%s)\n' "$before"
else
  fail=$((fail + 1))
  printf '  FAIL  expected %s.1 after rotate\n' "$AGENT_RUN_AUDIT_FILE"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
