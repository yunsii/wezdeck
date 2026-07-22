#!/usr/bin/env bash
# Cookbook: dry-run poke into Dex DM (agent-poke identity).
# Override: SB_POKE_TARGET=agent:main:feishu:direct:… ./03-poke-dry-run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${SB_POKE_TARGET:-dex}"
exec "$ROOT/scripts/session-bridge.sh" --json poke --id "$TARGET" \
  --message "status only: no code changes" --dry-run
