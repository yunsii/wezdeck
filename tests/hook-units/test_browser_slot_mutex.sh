#!/usr/bin/env bash
# Dry-run / resolve checks for browser-slot-mutex-lib.sh (no live Windows kills).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/runtime/browser-slot-mutex-lib.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok  %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

printf '▸ browser-slot-mutex dry-run\n'

out="$(browser_slot_mutex_prepare_cdp 1 2>&1 || true)"
printf '%s\n' "$out" | grep -q 'dry-run: ChromeDebugAutoStartEnabled=1' && ok 'prepare_cdp dry-run' || bad 'prepare_cdp dry-run'

out="$(browser_slot_mutex_teardown_other ego 1 2>&1 || true)"
printf '%s\n' "$out" | grep -q 'dry-run: ChromeDebugAutoStartEnabled=0' && ok 'teardown ego dry-run' || bad 'teardown ego dry-run'

out="$(browser_slot_mutex_teardown_other cdp 1 2>&1 || true)"
printf '%s\n' "$out" | grep -q 'dry-run: stop ego' && ok 'teardown cdp dry-run' || bad 'teardown cdp dry-run'

if browser_slot_mutex_teardown_other nope 1 2>/dev/null; then
  bad 'rejects bad backend'
else
  ok 'rejects bad backend'
fi

# Resolve helpers should be callable even without Windows (may leave empty udd).
browser_slot_mutex_resolve_chrome
[[ -n "$BS_CHROME_PATH" ]] && ok "resolve chrome_path=$BS_CHROME_PATH" || bad 'resolve chrome_path'
[[ -n "$BS_CHROME_PORT" ]] && ok "resolve port=$BS_CHROME_PORT" || bad 'resolve port'

printf 'browser_slot_mutex: %d passed, %d failed\n' "$pass" "$fail"
((fail == 0))
