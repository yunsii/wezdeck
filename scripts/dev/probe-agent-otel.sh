#!/usr/bin/env bash
# Live OTLP schema calibration probe for Claude, Codex, and Grok.
#
# Starts an ephemeral `wezdeck-wsl otel` listener on a loopback port with
# sanitized `--capture-raw`, sends one short non-interactive prompt per
# selected CLI, and prints both the sanitized OTLP schema and the extracted
# token-rate samples.
#
# Usage:
#   scripts/dev/probe-agent-otel.sh
#   scripts/dev/probe-agent-otel.sh --providers claude,codex,grok
#   scripts/dev/probe-agent-otel.sh --port 43189
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BIN="$REPO_ROOT/native/wezdeck-wsl/bin/wezdeck-wsl"

# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/runtime/runtime-env-lib.sh"
runtime_env_load_managed 2>/dev/null || true
runtime_env_add_user_cli_paths 2>/dev/null || true

PROVIDERS="claude,codex,grok"
PORT=43189
PROMPT="In 35 words, explain what OpenTelemetry OTLP is. No tools."

while (( $# )); do
  case "$1" in
    --providers) PROVIDERS="${2:?missing providers}"; shift 2 ;;
    --port)      PORT="${2:?missing port}"; shift 2 ;;
    -h|--help)   sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -x "$BIN" ]] || bash "$REPO_ROOT/native/wezdeck-wsl/build.sh"

TMP="$(mktemp -d /tmp/wezdeck-otel-probe.XXXXXX)"
OTEL_PID=""
cleanup() {
  if [[ -n "$OTEL_PID" ]]; then
    kill "$OTEL_PID" 2>/dev/null || true
    wait "$OTEL_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

LOG="$TMP/samples.jsonl"
STATUS="$TMP/status.json"
RAW="$TMP/raw-schema.jsonl"
LISTEN="127.0.0.1:${PORT}"

"$BIN" otel --listen "$LISTEN" --log "$LOG" --status "$STATUS" --capture-raw "$RAW" >"$TMP/otel.stderr" 2>&1 &
OTEL_PID=$!

for _ in $(seq 1 30); do
  if curl -fsS --max-time 1 "http://${LISTEN}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! curl -fsS --max-time 1 "http://${LISTEN}/health" >/dev/null 2>&1; then
  printf 'probe: otel collector failed to start on %s:\n' "$LISTEN" >&2
  cat "$TMP/otel.stderr" >&2 || true
  exit 1
fi

run_one() {
  local p="$1"
  printf '\n=== probing %s ===\n' "$p"
  case "$p" in
    claude|claude-kimi|claude-sub2api)
      local bin
      bin="$(command -v claude 2>/dev/null || true)"
      if [[ -z "$bin" ]]; then printf 'skip: claude not found on PATH\n'; return 0; fi
      (
        # shellcheck disable=SC1091
        . "$REPO_ROOT/scripts/runtime/agent-claude-sub2api-lib.sh"
        case "$p" in
          claude) clear_anthropic_gateway_env ;;
          claude-kimi) load_claude_kimi_env ;;
          claude-sub2api) load_claude_sub2api_env ;;
        esac
        timeout 60 env \
          CLAUDE_CODE_ENABLE_TELEMETRY=1 \
          OTEL_LOGS_EXPORTER=otlp \
          OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json \
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="http://${LISTEN}/v1/logs" \
          OTEL_RESOURCE_ATTRIBUTES="wezdeck.provider=claude,wezdeck.profile=${p}" \
          "$bin" -p "$PROMPT" --no-session-persistence --tools "" >/dev/null 2>"$TMP/${p}.err" \
          || printf '%s exited non-zero (%s)\n' "$p" "$(head -n 3 "$TMP/${p}.err" | tr '\n' ' ')"
      )
      ;;
    codex)
      local bin
      bin="$(command -v codex 2>/dev/null || true)"
      if [[ -z "$bin" ]]; then printf 'skip: codex not found on PATH\n'; return 0; fi
      timeout 60 env \
        OTEL_RESOURCE_ATTRIBUTES="wezdeck.provider=codex,wezdeck.profile=codex" \
        "$bin" -c 'otel.log_user_prompt=false' \
        -c "otel.exporter={otlp-http={endpoint=\"http://${LISTEN}/v1/logs\",protocol=\"json\"}}" \
        exec --ephemeral --skip-git-repo-check "$PROMPT" >/dev/null 2>"$TMP/codex.err" \
        || printf 'codex exited non-zero (%s)\n' "$(head -n 3 "$TMP/codex.err" | tr '\n' ' ')"
      ;;
    grok)
      local bin
      bin="$(command -v grok 2>/dev/null || true)"
      if [[ -z "$bin" ]]; then printf 'skip: grok not found on PATH\n'; return 0; fi
      timeout 60 env \
        GROK_EXTERNAL_OTEL=1 \
        OTEL_LOGS_EXPORTER=otlp \
        OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
        OTEL_EXPORTER_OTLP_ENDPOINT="http://${LISTEN}" \
        OTEL_RESOURCE_ATTRIBUTES="wezdeck.provider=grok,wezdeck.profile=grok" \
        "$bin" -p "$PROMPT" >/dev/null 2>"$TMP/grok.err" \
        || printf 'grok exited non-zero (%s)\n' "$(head -n 3 "$TMP/grok.err" | tr '\n' ' ')"
      ;;
    *)
      printf 'unknown provider: %s\n' "$p" >&2
      ;;
  esac
}

IFS=',' read -r -a list <<<"$PROVIDERS"
for p in "${list[@]}"; do
  run_one "$p"
done

# Give OTLP batch exporters a moment to flush on process exit.
sleep 1.5

printf '\n=== collector health ===\n'
curl -fsS --max-time 2 "http://${LISTEN}/health" || true
printf '\n\n=== extracted samples (%s) ===\n' "$LOG"
if [[ -s "$LOG" ]]; then
  cat "$LOG"
else
  printf '(none)\n'
fi
printf '\n=== sanitized raw OTLP schema (%s) ===\n' "$RAW"
if [[ -s "$RAW" ]]; then
  cat "$RAW"
else
  printf '(none)\n'
fi
