#!/usr/bin/env bash
# Run every contrib plugin's own test entry (contrib/plugins/<id>/tests/run.sh)
# so optional plugins stay green with core changes.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export WEZDECK_REPO="$repo_root"
rc=0 n=0
for t in "$repo_root"/contrib/plugins/*/tests/run.sh; do
  [[ -f "$t" ]] || continue
  n=$((n + 1))
  echo "── $(basename "$(dirname "$(dirname "$t")")")"
  bash "$t" || rc=1
done
echo "contrib plugins: $n suite(s)"
exit "$rc"
