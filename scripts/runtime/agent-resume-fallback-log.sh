#!/usr/bin/env bash
# Best-effort workflow breadcrumb when <base>-resume falls back to a fresh CLI.
# Invoked from agent-launcher.sh inside the `||` branch of:
#   claude --continue || { …; exec claude; }
# Keep this script tiny and silent-on-failure — it sits on the agent boot path.
set -u

agent="${1:-unknown}"
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$script_dir/runtime-log-lib.sh" 2>/dev/null || exit 0
runtime_log_info primary_pane "agent resume fallback fresh" \
  "agent=$agent" "mode=resume_fallback_fresh" "cwd=$PWD" || true
