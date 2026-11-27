#!/usr/bin/env bash
# Offline checks for review adapters: the shared invoke result must remain
# distinguishable from a successful model reply.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
. "$here/lib/select-backends.sh"

case_name=''
host_agent_invoke_run() {
  case "$case_name" in
    claude_error)
      printf '%s' '{"is_error":true,"api_error_code":"verification_required","result":"API Error"}'
      return 1 ;;
    claude_ok) printf '%s' '{"is_error":false,"result":"ping-ok"}' ;;
    grok_error) printf '%s' '{"error":"request_failed","text":"API Error"}'; return 1 ;;
    grok_ok) printf '%s' '{"text":"ping-ok"}' ;;
    codex_error)
      printf '%s\n' '{"type":"item.completed","item":{"type":"error","message":"API Error"}}'
      return 1 ;;
    codex_ok)
      printf '%s\n' '{"type":"item.completed","item":{"type":"error","message":"ignored config"}}' '{"type":"item.completed","item":{"type":"agent_message","text":"ping-ok"}}' '{"type":"turn.completed"}' ;;
  esac
}

check_failure() {
  local got
  if got="$(printf 'prompt' | "$1" '' 2>/dev/null)"; then
    echo "FAIL: $1 accepted $case_name" >&2
    exit 1
  fi
  [ -z "$got" ] || { echo "FAIL: $1 leaked failed reply" >&2; exit 1; }
}
check_success() {
  local got
  got="$(printf 'prompt' | "$1" '')"
  [ "$got" = ping-ok ] || { echo "FAIL: $1 returned $got" >&2; exit 1; }
}

case_name=claude_error; check_failure claude__invoke
case_name=claude_ok; check_success claude__invoke
case_name=grok_error; check_failure grok__invoke
case_name=grok_ok; check_success grok__invoke
case_name=codex_error; check_failure codex__invoke
case_name=codex_ok; check_success codex__invoke

_PROBE_RESULT=(); _PROBE_REASON=()
provider_available() { return 1; }
ADV_REVIEW_PROBE=0
if select_review_backends codex; then
  echo 'FAIL: selected unavailable backends' >&2
  exit 1
fi
[[ "$SEL_REASON" == *'claude=not_on_path'* ]] || exit 1
[[ "$SEL_REASON" == *'codex=not_on_path'* ]] || exit 1
[[ "$SEL_REASON" == *'grok=not_on_path'* ]] || exit 1

_PROBE_RESULT=(); _PROBE_REASON=()
calls=0
provider_available() { calls=$((calls + 1)); return 0; }
_avail grok
_avail grok
[ "$calls" -eq 1 ] || { echo 'FAIL: repeated availability probe' >&2; exit 1; }

echo 'provider-health: ok'
