#!/usr/bin/env bash
# Agent entry: ensure env, then wd-run propose.
# Usage: propose.sh --cwd DIR [--actor A] [--summary S] (--file F | --stdin | -)
set -euo pipefail

TOOL_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WD_RUN="$("$TOOL_HOME/ensure-env.sh")" || exit 1
exec "$WD_RUN" propose "$@"
