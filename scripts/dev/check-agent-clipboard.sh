#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOST_LIB="$REPO_ROOT/scripts/dev/windows-runtime-host/lib.sh"
CLI_PATH="$REPO_ROOT/scripts/runtime/agent-clipboard.sh"

# shellcheck disable=SC1091
source "$HOST_LIB"

usage() {
  cat <<'EOF'
usage:
  scripts/dev/check-agent-clipboard.sh [--timeout-seconds N]

Validate the repo-local agent-clipboard wrapper against the live Windows helper.
EOF
}

TIMEOUT_SECONDS=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout-seconds)
      [[ $# -ge 2 ]] || host_check_die "missing value for --timeout-seconds"
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      host_check_die "unknown argument: $1"
      ;;
  esac
done

[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || host_check_die "--timeout-seconds must be an integer"
HOST_CHECK_TIMEOUT_SECONDS="$TIMEOUT_SECONDS"

[[ -x "$CLI_PATH" ]] || host_check_die "agent-clipboard script is missing or not executable: $CLI_PATH"

host_check_init_environment "$REPO_ROOT"
host_check_ensure_helper

text_trace="agent-clipboard-text-$(date +%Y%m%dT%H%M%S)-$$"
text_payload="agent-clipboard-smoke $(date '+%Y-%m-%d %H:%M:%S %z')"
host_check_trace "step=write-text cli=$CLI_PATH trace_id=$text_trace"
printf '%s' "$text_payload" | "$CLI_PATH" write-text --stdin --trace-id "$text_trace" --quiet

resolve_text_response="$(host_check_invoke_helper_request_capture "$(printf '{"version":2,"trace_id":%s,"message_type":"request","domain":"clipboard","action":"resolve_for_paste","payload":{}}' \
  "$(host_check_json_escape "${text_trace}-resolve")")")" || host_check_die "clipboard resolve_for_paste failed after text write"
[[ "$(host_check_env_value_from_text result_type "$resolve_text_response")" == "clipboard_text" ]] || host_check_die "clipboard text resolve returned unexpected result_type"
[[ "$(host_check_env_value_from_text result_text "$resolve_text_response")" == "$text_payload" ]] || host_check_die "clipboard text resolve returned unexpected text"
host_check_pass "agent-clipboard text write processed"

sleep 1

image_trace="agent-clipboard-image-$(date +%Y%m%dT%H%M%S)-$$"
test_png="$REPO_ROOT/assets/copy-test.png"
[[ -f "$test_png" ]] || host_check_die "missing image smoke asset: $test_png"
host_check_trace "step=write-image cli=$CLI_PATH trace_id=$image_trace image_path=$test_png"
"$CLI_PATH" write-image-file "$test_png" --trace-id "$image_trace" --quiet

resolve_image_response="$(host_check_invoke_helper_request_capture "$(printf '{"version":2,"trace_id":%s,"message_type":"request","domain":"clipboard","action":"resolve_for_paste","payload":{}}' \
  "$(host_check_json_escape "${image_trace}-resolve")")")" || host_check_die "clipboard resolve_for_paste failed after image write"
[[ "$(host_check_env_value_from_text result_type "$resolve_image_response")" == "clipboard_image" ]] || host_check_die "clipboard image resolve returned unexpected result_type"
[[ -n "$(host_check_env_value_from_text result_formats "$resolve_image_response")" ]] || host_check_die "clipboard image resolve returned no formats"
host_check_pass "agent-clipboard image write processed"
