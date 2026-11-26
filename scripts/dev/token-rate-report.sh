#!/usr/bin/env bash
# Host-side agent token output-rate diagnostic report.
#
# Combines Route B (loopback OTLP collector: ~/.local/state/wezterm-runtime/
# logs/agent-token-rate.jsonl) with Route A transcript step-window fallback
# (Agy by default, plus optional Claude/Codex fallback via --transcript-all).
#
# Examples:
#   scripts/dev/token-rate-report.sh                  # last 7 days, by provider/profile/model
#   scripts/dev/token-rate-report.sh --today
#   scripts/dev/token-rate-report.sh --days 14 --provider claude
#   scripts/dev/token-rate-report.sh --profile claude-kimi
#   scripts/dev/token-rate-report.sh --source otel    # otel | transcript | all
#   scripts/dev/token-rate-report.sh --live           # collector status + active session rates
#   scripts/dev/token-rate-report.sh --watch          # live tail of OTel samples
#   scripts/dev/token-rate-report.sh --raw today      # per-request detail rows
#   scripts/dev/token-rate-report.sh --json           # machine-readable output
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/runtime/wsl-runtime-paths-lib.sh"

export WEZDECK_TOKEN_RATE_LOG="${WEZDECK_TOKEN_RATE_LOG:-$WSL_AGENT_TOKEN_RATE_LOG_FILE}"
export WEZDECK_TOKEN_RATE_STATUS="${WEZDECK_TOKEN_RATE_STATUS:-$WSL_AGENT_TOKEN_RATE_STATUS_FILE}"

exec python3 "$SCRIPT_DIR/token_rate_report.py" "$@"
