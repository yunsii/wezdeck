#!/usr/bin/env bash
# Cookbook: list claw sessions (last 3h) as SessionCards.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$ROOT/scripts/session-bridge.sh" --json claw-ls --active 180
