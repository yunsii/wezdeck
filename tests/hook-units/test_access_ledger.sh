#!/usr/bin/env bash
# Unit tests for scripts/runtime/access-ledger-lib.sh
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lib="$repo_root/scripts/runtime/access-ledger-lib.sh"

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

sandbox="$(mktemp -d -t access-ledger-test.XXXXXX)"
trap 'rm -rf "$sandbox"' EXIT
export XDG_STATE_HOME="$sandbox/xdg"
mkdir -p "$XDG_STATE_HOME"

# shellcheck disable=SC1090
source "$lib"

ledger="$(access_ledger_path)"
assert_contains "ledger path under xdg state" "$ledger" "wezterm-runtime/state/access-ledger.json"

access_ledger_touch "sess-a" "/tmp/wt-a" 1000
access_ledger_touch "sess-a" "/tmp/wt-b" 2000
access_ledger_touch "sess-b" "/tmp/wt-c" 1500

got="$(access_ledger_session_ms sess-a)"
assert_eq "session a last ms" "$got" "2000"

got="$(access_ledger_session_last_path sess-a)"
assert_eq "session a last path" "$got" "/tmp/wt-b"

got="$(access_ledger_worktree_ms /tmp/wt-a)"
assert_eq "worktree a ms retained" "$got" "1000"

recent="$(access_ledger_session_recent_paths sess-a 5 | tr '\n' ' ')"
assert_contains "recent paths MRU head" "$recent" "/tmp/wt-b"
assert_contains "recent paths keep older" "$recent" "/tmp/wt-a"

tsv="$(access_ledger_all_session_ms_tsv)"
assert_contains "all sessions tsv has a" "$tsv" $'sess-a\t2000'
assert_contains "all sessions tsv has b" "$tsv" $'sess-b\t1500'

# Cap: touching more than ACCESS_LEDGER_RECENT_CAP keeps newest only.
ACCESS_LEDGER_RECENT_CAP=2
access_ledger_touch "sess-a" "/tmp/wt-d" 3000
access_ledger_touch "sess-a" "/tmp/wt-e" 4000
recent="$(access_ledger_session_recent_paths sess-a 10)"
lines="$(printf '%s\n' "$recent" | grep -c . || true)"
assert_eq "recent cap enforced" "$lines" "2"
assert_contains "newest path kept" "$recent" "/tmp/wt-e"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
