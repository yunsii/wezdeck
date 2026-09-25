#!/usr/bin/env bash
# Agent entry: ensure env, then wd-run propose.
# Default: --wait so the tool call blocks until the human finishes `x`
# (same shape as a normal background/blocking shell task — no attention badge).
# Pass --no-wait to only enqueue.
#
# Usage: propose.sh --cwd DIR [--actor A] [--summary S] [--timeout SEC] [--no-wait]
#                  (--file F | --stdin | -)
set -euo pipefail

source_file="$(readlink -f "${BASH_SOURCE[0]}")"
TOOL_HOME="$(cd "$(dirname "$source_file")" && pwd -P)"
WD_RUN="$("$TOOL_HOME/ensure-env.sh")" || exit 1

wait_args=(--wait)
forward=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-wait)
      wait_args=()
      shift
      ;;
    --timeout)
      forward+=(--timeout "${2:-0}")
      shift 2
      ;;
    *)
      forward+=("$1")
      shift
      ;;
  esac
done

exec "$WD_RUN" propose "${wait_args[@]}" "${forward[@]}"
