#!/usr/bin/env bash
# Backwards-compatible Claude Code hook entrypoint. The implementation lives in
# scripts/runtime/agent-attention/ so other agent CLIs can share the state
# machine without depending on Claude-specific payload parsing.

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

exec "$repo_root/scripts/runtime/agent-attention/adapters/claude.sh" "$@"
