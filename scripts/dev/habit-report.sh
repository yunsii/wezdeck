#!/usr/bin/env bash
# Personal habit + agent-efficiency metrics (pluginized Claude/Grok/Codex).
#
# Primary:
#   - concurrent agent sessions (runtime.log attention edges)
#   - skills / MCP / CLI via providers under scripts/dev/habit_report/providers/
# Secondary:
#   - wezterm.log hotkey pressed rows + hotkey-usage.json intensity
#
# Examples:
#   scripts/dev/habit-report.sh
#   scripts/dev/habit-report.sh --days 3
#   scripts/dev/habit-report.sh --providers claude,grok
#   scripts/dev/habit-report.sh --json
#   scripts/dev/habit-report.sh --paths
#
# See docs/diagnostics.md "Habit report".
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
py="$script_dir/habit-report.py"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/wsl-runtime-paths-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/hotkey-usage-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/runtime-env-lib.sh"
windows_runtime_detect_paths >/dev/null 2>&1 || true
# Pick up WAKATIME_API_KEY from shared.env / shell-env.d when present.
runtime_env_load_managed

days=7
end='today'
providers='claude,grok,codex'
format_json=0
no_lifetime=0
no_hotkeys=0
wakatime=0
paths_only=0
wezterm_log="${WINDOWS_RUNTIME_STATE_WSL:-}/logs/wezterm.log"
runtime_log="${WSL_RUNTIME_LOG_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/logs/runtime.log}"
usage_json="$(hotkey_usage_path 2>/dev/null || true)"
claude_root="${HOME}/.claude/projects"
grok_root="${GROK_HOME:-$HOME/.grok}/sessions"
codex_root="${CODEX_HOME:-$HOME/.codex}/sessions"

usage() {
  sed -n '2,16p' "$0"
}

while (( $# )); do
  case "$1" in
    --days) days="${2:?}"; shift 2 ;;
    --end) end="${2:?}"; shift 2 ;;
    --providers) providers="${2:?}"; shift 2 ;;
    --json) format_json=1; shift ;;
    --no-lifetime) no_lifetime=1; shift ;;
    --no-hotkeys) no_hotkeys=1; shift ;;
    --wakatime) wakatime=1; shift ;;
    --no-wakatime) wakatime=0; shift ;;
    --wezterm-log) wezterm_log="${2:?}"; shift 2 ;;
    --runtime-log) runtime_log="${2:?}"; shift 2 ;;
    --usage-json) usage_json="${2:?}"; shift 2 ;;
    --claude-root) claude_root="${2:?}"; shift 2 ;;
    --grok-root) grok_root="${2:?}"; shift 2 ;;
    --codex-root) codex_root="${2:?}"; shift 2 ;;
    --paths) paths_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null 2>&1 || { echo 'python3 required' >&2; exit 1; }
[[ -f "$py" ]] || { printf 'missing: %s\n' "$py" >&2; exit 1; }

if [[ -n "$usage_json" ]]; then
  hotkey_usage_migrate_legacy "$usage_json" >/dev/null 2>&1 || true
fi

args=(
  --days "$days"
  --end "$end"
  --providers "$providers"
  --wezterm-log "$wezterm_log"
  --runtime-log "$runtime_log"
  --claude-root "$claude_root"
  --grok-root "$grok_root"
  --codex-root "$codex_root"
)
[[ -n "$usage_json" ]] && args+=(--usage-json "$usage_json")
(( format_json )) && args+=(--json)
(( no_lifetime )) && args+=(--no-lifetime)
(( no_hotkeys )) && args+=(--no-hotkeys)
(( wakatime )) && args+=(--wakatime) || args+=(--no-wakatime)
(( paths_only )) && args+=(--paths-only)

exec python3 "$py" "${args[@]}"
