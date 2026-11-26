#!/usr/bin/env bash
# agent-otel-lib.sh — fail-open loopback OTLP wiring for managed agent CLIs.
#
# Sourced by scripts/runtime/agent-launcher.sh (single launch site).
# Only injects OTLP env/args when:
#   1. WEZDECK_OTEL_ENABLED != 0 (default enabled), AND
#   2. The local loopback collector is listening on WEZDECK_OTEL_PORT (checked in
#      <1 ms via /proc/net/tcp, no subprocess or network dial), OR
#      WEZDECK_OTEL_FORCE=1 (tests / explicit opt-in).
#   3. The caller has not already set OTEL_EXPORTER_OTLP_ENDPOINT (or
#      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).
#
# Privacy: never enables prompt/body logging; only timing + token counters.

WEZDECK_OTEL_DEFAULT_PORT=43180

wezdeck_otel_port() {
  local p="${WEZDECK_OTEL_PORT:-$WEZDECK_OTEL_DEFAULT_PORT}"
  if [[ "$p" =~ ^[0-9]+$ ]] && (( p >= 1 && p <= 65535 )); then
    printf '%s\n' "$p"
    return 0
  fi
  printf '%s\n' "$WEZDECK_OTEL_DEFAULT_PORT"
}

# Fast (<1 ms) check whether this user's loopback collector is installed and in
# TCP LISTEN state (0A) on 127.0.0.1:$port. Requiring the user's status.json
# keeps isolated test HOMEs from picking up a live host daemon.
wezdeck_otel_collector_listening() {
  local port="$1"
  if [[ "${WEZDECK_OTEL_FORCE:-0}" == "1" ]]; then
    return 0
  fi
  local status_file="${WEZDECK_TOKEN_RATE_STATUS:-${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/agent-token-rate/status.json}"
  [[ -f "$status_file" ]] || return 1
  local hex_port
  hex_port="$(printf '%04X' "$port")"
  # 0100007F = 127.0.0.1 in little-endian hex; state 0A = TCP_LISTEN.
  if [[ -r /proc/net/tcp ]]; then
    awk -v target="0100007F:${hex_port}" '
      NR > 1 && $2 == target && $4 == "0A" { found = 1; exit }
      END { exit(found ? 0 : 1) }
    ' /proc/net/tcp 2>/dev/null && return 0
    return 1
  fi
  return 1
}

wezdeck_otel_append_resource_attr() {
  local pair="$1"
  if [[ -z "${OTEL_RESOURCE_ATTRIBUTES:-}" ]]; then
    OTEL_RESOURCE_ATTRIBUTES="$pair"
  elif [[ ",${OTEL_RESOURCE_ATTRIBUTES}," != *",${pair},"* ]]; then
    OTEL_RESOURCE_ATTRIBUTES="${OTEL_RESOURCE_ATTRIBUTES},${pair}"
  fi
  export OTEL_RESOURCE_ATTRIBUTES
}

# Populates WEZDECK_OTEL_CODEX_ARGS (array) and exports OTel env vars for the
# given managed agent profile (claude | claude-sub2api | claude-kimi | codex |
# grok). No-op for agy (uses transcript fallback) or when collector is down.
wezdeck_otel_configure_agent() {
  local profile="$1"
  WEZDECK_OTEL_CODEX_ARGS=()

  if [[ "${WEZDECK_OTEL_ENABLED:-1}" == "0" ]]; then
    return 0
  fi

  local port
  port="$(wezdeck_otel_port)"
  if ! wezdeck_otel_collector_listening "$port"; then
    return 0
  fi

  local base_url="http://127.0.0.1:${port}"
  local logs_url="${base_url}/v1/logs"

  case "$profile" in
    claude|claude-sub2api|claude-kimi)
      if [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" || -n "${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-}" ]]; then
        return 0
      fi
      export CLAUDE_CODE_ENABLE_TELEMETRY=1
      export OTEL_LOGS_EXPORTER=otlp
      export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
      export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$logs_url"
      wezdeck_otel_append_resource_attr "wezdeck.provider=claude"
      wezdeck_otel_append_resource_attr "wezdeck.profile=${profile}"
      if [[ -n "${TMUX_PANE:-}" ]]; then
        wezdeck_otel_append_resource_attr "wezdeck.pane=${TMUX_PANE}"
      fi
      ;;
    grok)
      if [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" || -n "${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-}" ]]; then
        return 0
      fi
      export GROK_EXTERNAL_OTEL=1
      export OTEL_LOGS_EXPORTER=otlp
      export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
      export OTEL_EXPORTER_OTLP_ENDPOINT="$base_url"
      wezdeck_otel_append_resource_attr "wezdeck.provider=grok"
      wezdeck_otel_append_resource_attr "wezdeck.profile=grok"
      if [[ -n "${TMUX_PANE:-}" ]]; then
        wezdeck_otel_append_resource_attr "wezdeck.pane=${TMUX_PANE}"
      fi
      ;;
    codex)
      if [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" || -n "${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-}" ]]; then
        return 0
      fi
      WEZDECK_OTEL_CODEX_ARGS=(
        -c 'otel.log_user_prompt=false'
        -c "otel.exporter={otlp-http={endpoint=\"${logs_url}\",protocol=\"json\"}}"
      )
      wezdeck_otel_append_resource_attr "wezdeck.provider=codex"
      wezdeck_otel_append_resource_attr "wezdeck.profile=codex"
      if [[ -n "${TMUX_PANE:-}" ]]; then
        wezdeck_otel_append_resource_attr "wezdeck.pane=${TMUX_PANE}"
      fi
      ;;
    *)
      ;;
  esac
}
