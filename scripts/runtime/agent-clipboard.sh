#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/windows-runtime-paths-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/windows-shell-lib.sh"

usage() {
  cat <<'EOF'
usage:
  scripts/runtime/agent-clipboard.sh write-text --stdin [--timeout-ms N] [--trace-id ID] [--quiet]
  scripts/runtime/agent-clipboard.sh write-text --text TEXT [--timeout-ms N] [--trace-id ID] [--quiet]
  scripts/runtime/agent-clipboard.sh write-image-file IMAGE_PATH [--timeout-ms N] [--trace-id ID] [--quiet]

Write text or an image file to the Windows clipboard through the existing host helper.

options:
  --stdin         Read text payload from stdin.
  --text TEXT     Use TEXT as the clipboard payload.
  --timeout-ms N  helperctl request timeout in milliseconds. Default: 5000.
  --trace-id ID   Override the trace id used for runtime/helper logs.
  --quiet         Suppress success output.
  -h, --help      Show this help text.
EOF
}

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}

env_value_from_text() {
  local key="${1:?missing key}"
  local text="${2-}"
  awk -F= -v wanted="$key" '$1==wanted {print $2; exit}' <<<"$text" | tr -d '\r'
}

die() {
  local message="${1:?missing message}"
  runtime_log_error clipboard "$message" "${@:2}"
  printf 'error: %s\n' "$message" >&2
  exit 1
}

require_windows_helper_environment() {
  command -v powershell.exe >/dev/null 2>&1 || die "powershell.exe not found in PATH"
  command -v cmd.exe >/dev/null 2>&1 || die "cmd.exe not found in PATH"
  command -v wslpath >/dev/null 2>&1 || die "wslpath not found in PATH"
  windows_runtime_detect_paths || die "failed to resolve Windows runtime paths"

  HELPER_STATE_WIN="$WINDOWS_HELPER_STATE_WIN"
  HELPER_STATE_WSL="$WINDOWS_HELPER_STATE_WSL"
  HELPER_CLIENT_WSL="$WINDOWS_HELPER_CLIENT_WSL"
  HELPER_LOG_WSL="$WINDOWS_HELPER_LOG_WSL"
  HELPER_ENSURE_WSL="$WINDOWS_HELPER_ENSURE_SCRIPT_WSL"
  HELPER_IPC_ENDPOINT="$WINDOWS_HELPER_IPC_ENDPOINT"
  CLIPBOARD_OUTPUT_WIN="$WINDOWS_CLIPBOARD_OUTPUT_WIN"
  RUNTIME_STATE_WIN="$WINDOWS_RUNTIME_STATE_WIN"

  [[ -f "$HELPER_ENSURE_WSL" ]] || die "windows helper bootstrap is missing; sync the runtime first" "helper_ensure_wsl=$HELPER_ENSURE_WSL"
  [[ -f "$HELPER_CLIENT_WSL" ]] || runtime_log_info clipboard "helperctl not installed yet; ensure step will install it" "helper_client_wsl=$HELPER_CLIENT_WSL"
}

helper_state_is_fresh() {
  windows_runtime_helper_state_is_fresh "$HELPER_STATE_WSL" 5000
}

ensure_windows_helper() {
  if helper_state_is_fresh; then
    runtime_log_info clipboard "agent-clipboard helper already healthy" "state_path=$HELPER_STATE_WSL"
    return 0
  fi

  runtime_log_info clipboard "agent-clipboard ensuring windows helper" "state_path=$HELPER_STATE_WSL"
  local helper_ensure_win=""
  helper_ensure_win="$(wslpath -w "$HELPER_ENSURE_WSL")"

  windows_run_powershell_script_utf8 "$helper_ensure_win" \
    -StatePath "$HELPER_STATE_WIN" \
    -ClipboardOutputDir "$CLIPBOARD_OUTPUT_WIN" \
    -ClipboardWslDistro "${WSL_DISTRO_NAME:-}" \
    -ClipboardImageReadRetryCount 12 \
    -ClipboardImageReadRetryDelayMs 100 \
    -ClipboardCleanupMaxAgeHours 48 \
    -ClipboardCleanupMaxFiles 32 \
    -HeartbeatTimeoutSeconds 5 \
    -HeartbeatIntervalMs 1000 \
    -DiagnosticsEnabled 1 \
    -DiagnosticsCategoryEnabled 1 \
    -DiagnosticsLevel info \
    -DiagnosticsFile "${RUNTIME_STATE_WIN}\\logs\\helper.log" \
    -DiagnosticsMaxBytes 5242880 \
    -DiagnosticsMaxFiles 5 >/dev/null

  helper_state_is_fresh || die "windows helper did not become healthy" "state_path=$HELPER_STATE_WSL"
}

invoke_helper_request_capture() {
  local request_body="${1:?missing request body}"
  local request_b64=""
  request_b64="$(printf '%s' "$request_body" | base64 | tr -d '\r\n')"
  "$HELPER_CLIENT_WSL" request --pipe "$HELPER_IPC_ENDPOINT" --payload-base64 "$request_b64" --timeout-ms "$REQUEST_TIMEOUT_MS"
}

request_write_text() {
  local text="${1-}"
  local request_body=""
  local output=""
  local exit_status=0

  request_body="$(printf '{"version":2,"trace_id":%s,"message_type":"request","domain":"clipboard","action":"write_text","payload":{"text":%s}}' \
    "$(json_escape "$WEZTERM_RUNTIME_TRACE_ID")" \
    "$(json_escape "$text")")"

  output="$(invoke_helper_request_capture "$request_body" 2>&1)" || {
    exit_status=$?
    die "helperctl clipboard write_text request failed" \
      "helper_client_wsl=$HELPER_CLIENT_WSL" \
      "exit_code=$exit_status" \
      "helper_output=$output"
  }

  local status=""
  status="$(env_value_from_text status "$output")"
  [[ "$status" == "clipboard_written_text" ]] || die "clipboard helper returned an unexpected text status" "status=$status" "helper_output=$output"

  runtime_log_info clipboard "agent-clipboard wrote text to clipboard" \
    "status=$status" \
    "text_length=${#text}" \
    "helperctl_elapsed_ms=$(env_value_from_text helperctl_elapsed_ms "$output")"

  if [[ "$QUIET" != "1" ]]; then
    printf 'Wrote %d characters to the Windows clipboard.\n' "${#text}"
  fi
}

request_write_image_file() {
  local image_path="${1:?missing image path}"
  local windows_image_path=""
  local request_body=""
  local output=""
  local exit_status=0
  local status=""

  windows_image_path="$(wslpath -w "$image_path")"
  request_body="$(printf '{"version":2,"trace_id":%s,"message_type":"request","domain":"clipboard","action":"write_image_file","payload":{"image_path":%s}}' \
    "$(json_escape "$WEZTERM_RUNTIME_TRACE_ID")" \
    "$(json_escape "$windows_image_path")")"

  output="$(invoke_helper_request_capture "$request_body" 2>&1)" || {
    exit_status=$?
    die "helperctl clipboard write_image_file request failed" \
      "helper_client_wsl=$HELPER_CLIENT_WSL" \
      "exit_code=$exit_status" \
      "helper_output=$output"
  }

  status="$(env_value_from_text status "$output")"
  [[ "$status" == "clipboard_written_image" ]] || die "clipboard helper returned an unexpected image status" "status=$status" "helper_output=$output"

  runtime_log_info clipboard "agent-clipboard wrote image file to clipboard" \
    "status=$status" \
    "image_path=$image_path" \
    "helperctl_elapsed_ms=$(env_value_from_text helperctl_elapsed_ms "$output")"

  if [[ "$QUIET" != "1" ]]; then
    printf 'Wrote image %s to the Windows clipboard.\n' "$image_path"
  fi
}

read_text_from_stdin() {
  local text=""
  text="$(cat)"
  printf '%s' "$text"
}

SUBCOMMAND="${1:-}"
if [[ -z "$SUBCOMMAND" ]]; then
  usage >&2
  exit 1
fi
shift || true

REQUEST_TIMEOUT_MS=5000
QUIET=0
start_ms="$(runtime_log_now_ms)"
WEZTERM_RUNTIME_TRACE_ID="${WEZTERM_RUNTIME_TRACE_ID:-$(runtime_log_generate_trace_id)}"
export WEZTERM_RUNTIME_TRACE_ID

case "$SUBCOMMAND" in
  write-text)
    text_source=""
    text_payload=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --stdin)
          [[ -z "$text_source" ]] || die "use either --stdin or --text for write-text"
          text_source="stdin"
          shift
          ;;
        --text)
          [[ $# -ge 2 ]] || die "missing value for --text"
          [[ -z "$text_source" ]] || die "use either --stdin or --text for write-text"
          text_source="text"
          text_payload="$2"
          shift 2
          ;;
        --timeout-ms)
          [[ $# -ge 2 ]] || die "missing value for --timeout-ms"
          REQUEST_TIMEOUT_MS="$2"
          shift 2
          ;;
        --trace-id)
          [[ $# -ge 2 ]] || die "missing value for --trace-id"
          WEZTERM_RUNTIME_TRACE_ID="$2"
          export WEZTERM_RUNTIME_TRACE_ID
          shift 2
          ;;
        --quiet)
          QUIET=1
          shift
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "unknown argument for write-text: $1"
          ;;
      esac
    done

    [[ -n "$text_source" ]] || die "write-text requires --stdin or --text"
    [[ "$REQUEST_TIMEOUT_MS" =~ ^[0-9]+$ ]] || die "--timeout-ms must be an integer"

    if [[ "$text_source" == "stdin" ]]; then
      text_payload="$(read_text_from_stdin)"
    fi

    [[ -n "$text_payload" ]] || die "refusing to overwrite the clipboard with empty text"

    require_windows_helper_environment
    ensure_windows_helper
    request_write_text "$text_payload"
    ;;
  write-image-file)
    image_path="${1:-}"
    [[ -n "$image_path" ]] || die "write-image-file requires IMAGE_PATH"
    shift || true

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --timeout-ms)
          [[ $# -ge 2 ]] || die "missing value for --timeout-ms"
          REQUEST_TIMEOUT_MS="$2"
          shift 2
          ;;
        --trace-id)
          [[ $# -ge 2 ]] || die "missing value for --trace-id"
          WEZTERM_RUNTIME_TRACE_ID="$2"
          export WEZTERM_RUNTIME_TRACE_ID
          shift 2
          ;;
        --quiet)
          QUIET=1
          shift
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "unknown argument for write-image-file: $1"
          ;;
      esac
    done

    [[ "$REQUEST_TIMEOUT_MS" =~ ^[0-9]+$ ]] || die "--timeout-ms must be an integer"
    [[ "$image_path" == /* ]] || die "write-image-file expects an absolute WSL path" "image_path=$image_path"
    [[ -f "$image_path" ]] || die "image file does not exist" "image_path=$image_path"

    require_windows_helper_environment
    ensure_windows_helper
    request_write_image_file "$image_path"
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    die "unknown subcommand: $SUBCOMMAND"
    ;;
esac

runtime_log_info clipboard "agent-clipboard completed" \
  "subcommand=$SUBCOMMAND" \
  "duration_ms=$(runtime_log_duration_ms "$start_ms")"
