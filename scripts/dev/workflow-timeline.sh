#!/usr/bin/env bash
# Project a day workflow timeline from existing WezDeck / OpenClaw logs.
#
# P0 consumer only — does not add new emitters. Reconstructs the daily loop:
#   workspace/tab → worktree select|create (+ resume / focus restore)
#   → in-slot attention jumps → host verify → recycle / interop
#
# Examples:
#   scripts/dev/workflow-timeline.sh
#   scripts/dev/workflow-timeline.sh --day yesterday --summary
#   scripts/dev/workflow-timeline.sh --include-transitions
#   scripts/dev/workflow-timeline.sh --day 2026-09-12 --jsonl
#   scripts/dev/workflow-timeline.sh --kind attention.jump --kind worktree.select
#   scripts/dev/workflow-timeline.sh --write
#   scripts/dev/workflow-timeline.sh --paths
#
# Privacy: drops session-bridge audit preview; never exports agent prompts.
# See docs/diagnostics.md "Workflow timeline".
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/wsl-runtime-paths-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"
windows_runtime_detect_paths >/dev/null 2>&1 || true

day='today'
format='table'
write=0
paths_only=0
include_transitions=0
kinds=()
wezterm_log="${WINDOWS_RUNTIME_STATE_WSL:-}/logs/wezterm.log"
runtime_log="${WSL_RUNTIME_LOG_FILE}"
helper_log="${WINDOWS_HELPER_LOG_WSL:-${WINDOWS_RUNTIME_STATE_WSL:-}/logs/helper.log}"
sb_audit="${HOME}/.openclaw/logs/session-bridge-audit.jsonl"
py="$script_dir/workflow-timeline.py"

resolve_day() {
  case "$1" in
    today) date '+%Y-%m-%d' ;;
    yesterday) date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || date -v-1d '+%Y-%m-%d' ;;
    *) printf '%s' "$1" ;;
  esac
}

usage() {
  sed -n '2,18p' "$0"
}

while (( $# )); do
  case "$1" in
    --day) day="${2:?}"; shift 2 ;;
    --summary) format='summary'; shift ;;
    --jsonl) format='jsonl'; shift ;;
    --table) format='table'; shift ;;
    --kind) kinds+=("$2"); shift 2 ;;
    --include-transitions) include_transitions=1; shift ;;
    --write) write=1; shift ;;
    --paths) paths_only=1; shift ;;
    --wezterm-log) wezterm_log="${2:?}"; shift 2 ;;
    --runtime-log) runtime_log="${2:?}"; shift 2 ;;
    --helper-log) helper_log="${2:?}"; shift 2 ;;
    --session-bridge-audit) sb_audit="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null 2>&1 || { echo 'python3 required' >&2; exit 1; }
[[ -f "$py" ]] || { printf 'missing projector: %s\n' "$py" >&2; exit 1; }

day_resolved="$(resolve_day "$day")"
write_path=""
if (( write )); then
  write_path="${WSL_WORKFLOW_DIR}/day-${day_resolved}.jsonl"
fi

args=(
  --day "$day_resolved"
  --wezterm-log "$wezterm_log"
  --runtime-log "$runtime_log"
  --format "$format"
)
if [[ -n "$helper_log" && -f "$helper_log" ]]; then
  args+=(--helper-log "$helper_log")
fi
if [[ -n "$sb_audit" && -f "$sb_audit" ]]; then
  args+=(--session-bridge-audit "$sb_audit")
fi
for k in "${kinds[@]+"${kinds[@]}"}"; do
  args+=(--kind "$k")
done
if (( include_transitions )); then
  args+=(--include-transitions)
fi
if [[ -n "$write_path" ]]; then
  args+=(--write "$write_path")
fi
if (( paths_only )); then
  args+=(--paths-only)
fi

missing=0
if [[ ! -r "$wezterm_log" ]]; then
  printf 'warn: wezterm log not readable: %s\n' "$wezterm_log" >&2
  missing=1
fi
if [[ ! -r "$runtime_log" ]]; then
  printf 'warn: runtime log not readable: %s\n' "$runtime_log" >&2
  missing=1
fi
if (( missing && ! paths_only )); then
  printf 'continuing with whatever sources are readable\n' >&2
fi

python3 "$py" "${args[@]}"
status=$?

if (( write && status == 0 )); then
  printf 'wrote %s\n' "$write_path" >&2
fi
exit "$status"
