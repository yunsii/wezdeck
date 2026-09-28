#!/usr/bin/env bash
# Read-only check for the Linux side of the WezDeck Runtime WSL bridge.
#
# Healthy means:
#   - native/wezdeck-wsl/bin/wezdeck-wsl exists and is executable
#   - a local framed bridge.status round-trip against a temp socket succeeds
#   - when the Windows Runtime HTTP surface is already up, GET /api/v1/wsl
#     reports available=true
#
# Exit 1 with a fix line per failure. --advisory always exits 0.
set -euo pipefail

advisory=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --advisory) advisory=1; shift ;;
    -h|--help)
      printf 'Usage: %s [--advisory]\n' "$(basename "$0")"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
bin="$repo_root/native/wezdeck-wsl/bin/wezdeck-wsl"
fail=0

note() { printf '[wezdeck-wsl-check] %s\n' "$*"; }

fail_line() {
  fail=1
  note "warning: $*"
}

check_binary() {
  if [[ -x "$bin" ]]; then
    note "binary ok path=$bin"
    return 0
  fi
  fail_line "missing executable $bin"
  note "fix: $repo_root/native/wezdeck-wsl/build.sh"
  note "fix: skills/wezdeck-runtime-ops/scripts/sync-runtime.sh  # builds wezdeck-wsl in the native subflow"
}

# Local framed round-trip: prove the binary can serve and answer bridge.status
# without needing the Windows Runtime process.
check_local_socket() {
  [[ -x "$bin" ]] || return 0

  local sock="" log="" serve_pid="" body=""
  sock="$(mktemp -u "${TMPDIR:-/tmp}/wezdeck-wsl-check.XXXXXX.sock")"
  log="$(mktemp "${TMPDIR:-/tmp}/wezdeck-wsl-check.XXXXXX.log")"
  cleanup() {
    if [[ -n "${serve_pid:-}" ]]; then
      kill "$serve_pid" >/dev/null 2>&1 || true
      wait "$serve_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$sock" "$log"
  }
  trap cleanup RETURN

  WEZDECK_WSL_SOCKET="$sock" WEZDECK_WSL_FOREGROUND=1 \
    "$bin" serve >"$log" 2>&1 &
  serve_pid=$!

  local i=0
  while (( i < 40 )); do
    [[ -S "$sock" ]] && break
    sleep 0.05
    i=$((i + 1))
  done
  if [[ ! -S "$sock" ]]; then
    fail_line "local serve did not create socket $sock"
    note "fix: inspect $log after re-running; rebuild with $repo_root/native/wezdeck-wsl/build.sh"
    return 0
  fi

  if ! body="$(
    WEZDECK_WSL_SOCKET="$sock" python3 - "$sock" <<'PY'
import json, socket, struct, sys
path = sys.argv[1]
req = json.dumps({
    "version": 2,
    "trace_id": "wezdeck-wsl-check",
    "domain": "bridge",
    "action": "status",
    "payload": {},
}).encode()
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
    s.settimeout(2.0)
    s.connect(path)
    s.sendall(struct.pack("<I", len(req)) + req)
    hdr = s.recv(4)
    if len(hdr) != 4:
        raise SystemExit("short frame header")
    n = struct.unpack("<I", hdr)[0]
    body = b""
    while len(body) < n:
        chunk = s.recv(n - len(body))
        if not chunk:
            break
        body += chunk
print(body.decode())
PY
  )"; then
    fail_line "local bridge.status round-trip failed"
    note "fix: $repo_root/native/wezdeck-wsl/build.sh"
    return 0
  fi

  if ! printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True; r=d.get("result") or {}; assert r.get("available") is True' 2>/dev/null; then
    fail_line "local bridge.status response was not available: $body"
    note "fix: $repo_root/native/wezdeck-wsl/build.sh"
    return 0
  fi

  note "local socket ok"
}

# When the Windows Runtime HTTP surface is already up, also require the live
# /api/v1/wsl snapshot. Skip quietly when the helper is not running.
check_live_http() {
  local paths_lib="$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"
  local state_file="" http_ready="" endpoint="" payload=""

  [[ -r "$paths_lib" ]] || return 0
  # shellcheck disable=SC1090
  source "$paths_lib"
  windows_runtime_detect_paths >/dev/null 2>&1 || return 0
  state_file="${WINDOWS_HELPER_STATE_WSL:-}"
  [[ -n "$state_file" && -f "$state_file" ]] || {
    note "live http skipped reason=helper_state_missing"
    return 0
  }

  http_ready="$(windows_runtime_state_value http_ready "$state_file")"
  endpoint="$(windows_runtime_state_value http_endpoint "$state_file")"
  if [[ "$http_ready" != "1" || -z "$endpoint" ]]; then
    note "live http skipped reason=http_not_ready"
    return 0
  fi

  if ! payload="$(curl -fsS -m 3 "${endpoint%/}/api/v1/wsl" 2>/dev/null)"; then
    fail_line "live GET ${endpoint%/}/api/v1/wsl failed while helper http_ready=1"
    note "fix: ensure wezdeck-runtime is running and native/wezdeck-wsl/bin/wezdeck-wsl exists"
    return 0
  fi

  if ! printf '%s' "$payload" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("available") is True' 2>/dev/null; then
    fail_line "live /api/v1/wsl available!=true payload=$payload"
    note "fix: $repo_root/native/wezdeck-wsl/build.sh && skills/wezdeck-runtime-ops/scripts/sync-runtime.sh"
    return 0
  fi

  note "live http ok endpoint=$endpoint"
}

check_binary
check_local_socket
check_live_http

if (( fail == 0 )); then
  note "healthy: wezdeck-wsl binary + local socket (+ live http when Runtime is up)"
  exit 0
fi
if (( advisory )); then
  exit 0
fi
exit 1
