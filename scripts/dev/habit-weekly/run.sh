#!/usr/bin/env bash
# Collect habit-report JSON for a week window and render a stable markdown report.
#
# Examples:
#   run.sh                         # previous complete Mon–Sun (default)
#   run.sh --week this             # current week so far (Mon → today)
#   run.sh --week last             # same as default: previous Mon–Sun
#   run.sh --since 2026-09-11 --until 2026-09-17
#   run.sh --write                 # also save under state/workflow/habit-weekly/
#   run.sh --write --push          # local write + push to habit archive repo
#   run.sh --json-only             # only emit habit-report JSON to stdout
#   run.sh --stdout                # print markdown (default when no --write)
#   run.sh --no-wakatime           # skip WakaTime summaries
#
# Relies on scripts/dev/habit-report.sh (Claude/Grok/Codex plugins + hotkeys +
# optional WakaTime). Archive push: push-archive.sh + ~/.config/habit-weekly/state.json.
set -euo pipefail

TOOL_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# habit-weekly → scripts/dev → scripts → repo root
repo_root="$(cd "$TOOL_HOME/../../.." && pwd)"
habit_sh="$repo_root/scripts/dev/habit-report.sh"
render_py="$TOOL_HOME/render.py"
push_sh="$TOOL_HOME/push-archive.sh"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/wsl-runtime-paths-lib.sh" 2>/dev/null || true
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/runtime-env-lib.sh" 2>/dev/null || true
if declare -F runtime_env_load_managed >/dev/null 2>&1; then
  runtime_env_load_managed
fi

# Default: last complete Mon–Sun. In-progress weeks need an explicit --week this.
week='last'
since=''
until=''
write=0
push=0
stdout=0
json_only=0
wakatime=1
providers='claude,grok,codex'
out_dir="${WSL_WORKFLOW_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/workflow}/habit-weekly"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

# Monday of the ISO week containing $1 (YYYY-MM-DD). GNU date.
monday_of() {
  local d=$1
  date -d "$d -$(( $(date -d "$d" +%u) - 1 )) days" +%Y-%m-%d
}

sunday_of_monday() {
  date -d "$1 +6 days" +%Y-%m-%d
}

while (( $# )); do
  case "$1" in
    --week) week="${2:?}"; shift 2 ;;
    --since) since="${2:?}"; shift 2 ;;
    --until) until="${2:?}"; shift 2 ;;
    --providers) providers="${2:?}"; shift 2 ;;
    --write) write=1; shift ;;
    --push) push=1; write=1; shift ;;
    --stdout) stdout=1; shift ;;
    --json-only) json_only=1; shift ;;
    --wakatime) wakatime=1; shift ;;
    --no-wakatime) wakatime=0; shift ;;
    --out-dir) out_dir="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null 2>&1 || { echo 'python3 required' >&2; exit 1; }
[[ -x "$habit_sh" || -f "$habit_sh" ]] || { printf 'missing %s\n' "$habit_sh" >&2; exit 1; }
[[ -f "$render_py" ]] || { printf 'missing %s\n' "$render_py" >&2; exit 1; }
if (( push )); then
  [[ -x "$push_sh" || -f "$push_sh" ]] || {
    printf 'missing %s\n' "$push_sh" >&2
    exit 1
  }
fi

today="$(date +%Y-%m-%d)"
if [[ -n "$since" || -n "$until" ]]; then
  [[ -n "$since" && -n "$until" ]] || {
    echo '--since and --until must both be set' >&2
    exit 2
  }
else
  case "$week" in
    this)
      since="$(monday_of "$today")"
      until="$today"
      ;;
    last)
      this_mon="$(monday_of "$today")"
      since="$(date -d "$this_mon -7 days" +%Y-%m-%d)"
      until="$(sunday_of_monday "$since")"
      ;;
    *)
      # Treat as a Monday date or any day inside the desired week.
      since="$(monday_of "$week")"
      until="$(sunday_of_monday "$since")"
      ;;
  esac
fi

# habit-report uses --days + --end (inclusive end).
days=$(( ( $(date -d "$until" +%s) - $(date -d "$since" +%s) ) / 86400 + 1 ))
if (( days < 1 )); then
  echo "empty window: $since → $until" >&2
  exit 2
fi

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/habit-weekly.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT
json_path="$tmpdir/habit.json"
md_path="$tmpdir/report.md"

habit_args=(
  --days "$days"
  --end "$until"
  --providers "$providers"
  --json
)
if (( wakatime )); then
  habit_args+=(--wakatime)
else
  habit_args+=(--no-wakatime)
fi

bash "$habit_sh" "${habit_args[@]}" >"$json_path"

# Annotate window start in case days math drifted (habit-report end-anchored).
python3 - "$json_path" "$since" "$until" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
data = json.loads(p.read_text(encoding="utf-8"))
data.setdefault("window", {})
data["window"]["start"] = sys.argv[2]
data["window"]["end"] = sys.argv[3]
data["window"]["label"] = f"{sys.argv[2]}→{sys.argv[3]}"
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

if (( json_only )); then
  cat "$json_path"
  exit 0
fi

python3 "$render_py" --input "$json_path" --output "$md_path"

stem="habit-weekly-${since}_to_${until}"
written_md=''
written_json=''

if (( write )); then
  mkdir -p "$out_dir"
  written_json="$out_dir/${stem}.json"
  written_md="$out_dir/${stem}.md"
  cp -f "$json_path" "$written_json"
  cp -f "$md_path" "$written_md"
  printf 'wrote %s\n' "$written_md" >&2
  printf 'wrote %s\n' "$written_json" >&2
fi

if (( push )); then
  bash "$push_sh" \
    --since "$since" \
    --until "$until" \
    --md "${written_md:-$md_path}" \
    --json "${written_json:-$json_path}"
fi

if (( write )); then
  if (( stdout )); then
    cat "$md_path"
  else
    printf '%s\n' "$written_md"
  fi
  exit 0
fi

# No --write: print markdown to stdout (agent can relay / save elsewhere).
cat "$md_path"
