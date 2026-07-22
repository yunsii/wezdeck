#!/usr/bin/env bash
# Cookbook: list host panes as SessionCards (tmux view).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$ROOT/scripts/session-bridge.sh" --json host-status
