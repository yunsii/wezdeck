#!/usr/bin/env bash
# Plugin compiler (scripts/runtime/plugins_compile.py) unit tests.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec python3 -m unittest -v "$repo_root/tests/plugins/test_plugins_compile.py" 2>&1
