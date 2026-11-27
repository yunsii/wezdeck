#!/usr/bin/env bash
# Fast unit test for scripts/dev/release-queue-lib.sh coalescing state transitions.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STATE="$TMP"
# shellcheck source=scripts/dev/release-queue-lib.sh
source "$REPO/scripts/dev/release-queue-lib.sh"

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL [$label]: got='$got', want='$want'" >&2
    exit 1
  fi
}

# 1. Multiple rapid lands coalesce into pending_commits & advance desired_sha.
release_state_update enqueue "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "aaaaaaaa" "feat: A"
release_state_update enqueue "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "bbbbbbbb" "feat: B"
assert_eq "$(release_state_get desired_sha)" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "desired advances"

# 2. Gate failure records failed_sha; a newer commit clears stale failure.
release_state_update failed "sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "phase=gate_failed" "error=smoke failed" "run_dir=/tmp/r1"
assert_eq "$(release_state_get phase)" "gate_failed" "phase gate_failed"
assert_eq "$(release_state_get failed_sha)" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "failed_sha stored"

release_state_update enqueue "cccccccccccccccccccccccccccccccccccccccc" "cccccccc" "fix: C"
assert_eq "$(release_state_get failed_sha)" "" "newer commit clears failed_sha"
assert_eq "$(release_state_get desired_sha)" "cccccccccccccccccccccccccccccccccccccccc" "desired at C"

# 3. Successful deploy advances deployed_sha, resets phase to idle, and clears pending.
release_state_update deployed "sha=cccccccccccccccccccccccccccccccccccccccc" "web_fp=w1" "relay_fp=r1" "run_dir=/tmp/r2"
assert_eq "$(release_state_get phase)" "idle" "phase idle after deploy"
assert_eq "$(release_state_get deployed_sha)" "cccccccccccccccccccccccccccccccccccccccc" "deployed at C"

# 4. Async verify records verdict without altering deployed_sha.
release_state_update verified "sha=cccccccccccccccccccccccccccccccccccccccc" "status=ok" "log=/tmp/v.log"
assert_eq "$(release_state_get verify_status)" "ok" "verify ok"
assert_eq "$(release_state_get deployed_sha)" "cccccccccccccccccccccccccccccccccccccccc" "deployed preserved"

# Land and deploy update the same state from different locks/processes.
for i in $(seq 1 12); do
  release_state_update enqueue "$(printf '%040d' "$i")" "$(printf '%08d' "$i")" "feat: $i" &
done
wait
assert_eq "$(python3 - "$(release_state_file)" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    print(len(json.load(stream)["pending_commits"]))
PY
)" "12" "concurrent enqueues retained"

# 5. release_read_relay_token prefers on-disk env file over stale shell env and strips export/quotes/CR.
ENV_FILE="$TMP/wezdeck-remote.env"
printf 'export WEZDECK_RELAY_CLIENT_TOKEN="disk-token-123"\r\n' >"$ENV_FILE"
got_tok="$(WEZDECK_REMOTE_ENV="$ENV_FILE" WEZDECK_RELAY_CLIENT_TOKEN=stale-env-tok release_read_relay_token)"
assert_eq "$got_tok" "disk-token-123" "token prefers on-disk file and strips export+quotes+CR"

printf "WEZDECK_RELAY_CLIENT_TOKEN='single-quoted'\n" >"$ENV_FILE"
got_tok="$(WEZDECK_REMOTE_ENV="$ENV_FILE" WEZDECK_RELAY_CLIENT_TOKEN=stale-env-tok release_read_relay_token)"
assert_eq "$got_tok" "single-quoted" "token strips single quotes"

got_tok="$(WEZDECK_REMOTE_ENV="$TMP/missing.env" WEZDECK_RELAY_CLIENT_TOKEN=env-fallback release_read_relay_token)"
assert_eq "$got_tok" "env-fallback" "token falls back to env when file missing"

# 6. release_live_canary absorbs transient build.json / entry JS / relay health propagation delays.
PORT_FILE="$TMP/port"
python3 - "$PORT_FILE" <<'PY' &
import http.server, json, socketserver, sys

counts = {"build": 0, "asset": 0, "relay": 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/build.json":
            counts["build"] += 1
            bid = "oldbuild" if counts["build"] < 3 else "newbuild"
            body = json.dumps({"buildId": bid}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/zh/console/sessions":
            body = b'<html><script src="/assets/index-abc.js"></script></html>'
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)
        elif path == "/assets/index-abc.js":
            counts["asset"] += 1
            code = 404 if counts["asset"] < 2 else 200
            self.send_response(code)
            self.end_headers()
            self.wfile.write(b"console.log(1)")
        elif path == "/relay/health":
            counts["relay"] += 1
            auth = self.headers.get("Authorization", "")
            if auth != "Bearer disk-token-123":
                self.send_response(401)
                self.end_headers()
                return
            code = 503 if counts["relay"] < 2 else 200
            self.send_response(code)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as srv:
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        f.write(str(srv.server_address[1]))
    while counts["relay"] < 2:
        srv.handle_request()
PY
SRV_PID=$!
for _ in $(seq 1 50); do [[ -s "$PORT_FILE" ]] && break; sleep 0.05; done
PORT="$(cat "$PORT_FILE")"
printf 'WEZDECK_RELAY_CLIENT_TOKEN=disk-token-123\n' >"$ENV_FILE"
canary_out="$(
  WEZDECK_REMOTE_ENV="$ENV_FILE" \
  WEZDECK_RELAY_CLIENT_TOKEN=stale-env \
  WEZDECK_CANARY_BUILD_ATTEMPTS=5 \
  WEZDECK_CANARY_ASSET_ATTEMPTS=3 \
  WEZDECK_CANARY_RELAY_ATTEMPTS=3 \
  WEZDECK_CANARY_SLEEP_S=0.05 \
  release_live_canary "http://127.0.0.1:$PORT" "newbuild"
)"
wait "$SRV_PID" || true
[[ "$canary_out" == *"ok: live canary healthy (newbuild, entry /assets/index-abc.js, relay HTTP 200)"* ]] || {
  echo "FAIL [live canary retry]: unexpected output '$canary_out'" >&2
  exit 1
}

echo "PASS: release-queue-lib state machine and live canary tests"
