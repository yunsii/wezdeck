#!/usr/bin/env bash
set -euo pipefail

# Agent-facing entry point: reveal a specific file in VS Code for review.
#
# Intended use — an agent generates a proposal/plan file, then runs:
#   bash scripts/runtime/open-file-in-vscode.sh docs/some-plan.md
# VS Code focuses (or opens) the file's repo/worktree window and reveals
# the file in it, reusing the same window-management pipeline as the
# `Alt+v` "open current dir" action.
#
# Accepts a relative or absolute path; relative paths resolve against the
# caller's cwd. Delegates all VS Code / Windows-helper logic to
# open-current-dir-in-vscode.sh --file.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF' >&2
usage:
  open-file-in-vscode.sh <file>

Reveal <file> in VS Code, focusing/opening its repo window. <file> may be
relative (resolved against the current directory) or absolute.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  '')
    usage
    exit 1
    ;;
esac

target_file="$1"

# Resolve to an absolute path without requiring realpath; the file must
# exist so we can canonicalize it (and so VS Code has something to open).
if [[ "$target_file" != /* ]]; then
  target_file="$PWD/$target_file"
fi
if [[ ! -f "$target_file" ]]; then
  printf 'open-file-in-vscode.sh: file does not exist: %s\n' "$target_file" >&2
  exit 1
fi
target_file="$(cd "$(dirname "$target_file")" && pwd)/$(basename "$target_file")"

exec bash "$SCRIPT_DIR/open-current-dir-in-vscode.sh" --file "$target_file"
