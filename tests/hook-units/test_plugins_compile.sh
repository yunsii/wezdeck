#!/usr/bin/env bash
# Plugin system Python suites (tests/plugins): compiler + agent-provider
# discovery for habit_report.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
exec python3 -m unittest discover -s tests/plugins -p 'test_*.py' -v 2>&1
