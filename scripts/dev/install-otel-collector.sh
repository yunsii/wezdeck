#!/usr/bin/env bash
# Install / manage the local loopback OTLP collector (`wezdeck-wsl otel`) for
# host-side agent token output-rate probing.
#
# Runs as a user systemd service (`wezdeck-otel.service`) listening strictly on
# 127.0.0.1:43180 (overridable via WEZDECK_OTEL_PORT). Writes rotated NDJSON
# samples and an atomic status.json snapshot under ~/.local/state/wezterm-runtime/.
#
# Usage:
#   ./scripts/dev/install-otel-collector.sh               # build + install + start
#   ./scripts/dev/install-otel-collector.sh --capture-raw # also enable sanitized schema capture
#   ./scripts/dev/install-otel-collector.sh --check       # unit + health check, no writes
#   ./scripts/dev/install-otel-collector.sh --status      # print /health JSON
#   ./scripts/dev/install-otel-collector.sh --uninstall
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BIN="$REPO_ROOT/native/wezdeck-wsl/bin/wezdeck-wsl"
UNIT_DIR="${SYSTEMD_USER_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT="wezdeck-otel.service"
PORT="${WEZDECK_OTEL_PORT:-43180}"
LISTEN="127.0.0.1:${PORT}"

# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/runtime/wsl-runtime-paths-lib.sh"

MODE=install
CAPTURE_RAW=0

while (( $# )); do
  case "$1" in
    --capture-raw) CAPTURE_RAW=1; shift ;;
    --check)       MODE=check; shift ;;
    --status)      MODE=status; shift ;;
    --uninstall)   MODE=uninstall; shift ;;
    --port)        PORT="${2:?missing port}"; LISTEN="127.0.0.1:${PORT}"; shift 2 ;;
    -h|--help)     sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

unit_text() {
  local extra_env=""
  if (( CAPTURE_RAW )); then
    extra_env="Environment=WEZDECK_OTEL_CAPTURE_RAW=1"
  fi
  cat <<EOF
[Unit]
Description=WezDeck: local loopback OTLP collector for agent token output rate (wezdeck-wsl otel)
Documentation=file://$REPO_ROOT/docs/diagnostics.md
After=default.target

[Service]
Type=simple
Environment=WEZDECK_OTEL_LISTEN=$LISTEN
${extra_env}
ExecStart=$BIN otel --listen $LISTEN --log $WSL_AGENT_TOKEN_RATE_LOG_FILE --status $WSL_AGENT_TOKEN_RATE_STATUS_FILE
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
}

check_health() {
  curl -fsS --max-time 2 "http://${LISTEN}/health" 2>/dev/null
}

case "$MODE" in
  install)
    "$REPO_ROOT/native/wezdeck-wsl/build.sh"
    mkdir -p "$UNIT_DIR"
    unit_text > "$UNIT_DIR/$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT" >/dev/null
    systemctl --user restart "$UNIT"
    sleep 0.3
    if health="$(check_health)"; then
      printf 'installed %s on http://%s (capture_raw=%d)\n' "$UNIT" "$LISTEN" "$CAPTURE_RAW"
      printf 'log=%s\nstatus=%s\n' "$WSL_AGENT_TOKEN_RATE_LOG_FILE" "$WSL_AGENT_TOKEN_RATE_STATUS_FILE"
      printf 'health=%s\n' "$(printf '%s' "$health" | tr -d '\n')"
    else
      printf 'installed %s, but http://%s/health did not respond yet; inspect: journalctl --user -u %s -n 30\n' \
        "$UNIT" "$LISTEN" "$UNIT" >&2
      exit 1
    fi
    ;;
  check)
    unit_state="$(systemctl --user is-active "$UNIT" 2>/dev/null || echo inactive)"
    if health="$(check_health)"; then
      printf 'otel-collector: ok unit=%s listen=http://%s\n' "$unit_state" "$LISTEN"
      exit 0
    fi
    printf 'otel-collector: down unit=%s listen=http://%s\n' "$unit_state" "$LISTEN" >&2
    exit 1
    ;;
  status)
    if health="$(check_health)"; then
      printf '%s\n' "$health"
    elif [[ -f "$WSL_AGENT_TOKEN_RATE_STATUS_FILE" ]]; then
      printf 'collector offline; last status file (%s):\n' "$WSL_AGENT_TOKEN_RATE_STATUS_FILE" >&2
      cat "$WSL_AGENT_TOKEN_RATE_STATUS_FILE"
      exit 1
    else
      printf 'otel-collector: not running and no status file at %s\n' "$WSL_AGENT_TOKEN_RATE_STATUS_FILE" >&2
      exit 1
    fi
    ;;
  uninstall)
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    printf 'removed %s (log/state kept at %s)\n' "$UNIT" "$WSL_AGENT_TOKEN_RATE_LOG_FILE"
    ;;
esac
