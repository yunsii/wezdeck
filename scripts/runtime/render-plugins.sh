#!/usr/bin/env bash
# render-plugins.sh — compile enabled WezDeck plugins into
# wezterm-x/plugins/registry.generated.{lua,json} (gitignored).
#
# Runs inside sync-runtime's prepare step, before the runtime tree is
# published; a plugin validation error fails the sync so a bad plugin never
# reaches the live WezTerm. Docs: docs/plugin-architecture.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

exec python3 "$SCRIPT_DIR/plugins_compile.py" --repo "$REPO_ROOT" "$@"
