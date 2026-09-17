#!/usr/bin/env bash
# Collect habit-report JSON for a week window and render a stable markdown report.
#
# Examples:
#   run.sh                         # this week so far (Mon → today)
#   run.sh --week last             # previous Mon–Sun
#   run.sh --since 2026-09-11 --until 2026-09-17
#   run.sh --write                 # also save under state/workflow/habit-weekly/
#   run.sh --json-only             # only emit habit-report JSON to stdout
#   run.sh --stdout                # print markdown (default when no --write)
#
# Relies on scripts/dev/habit-report.sh (Claude/Grok/Codex plugins + hotkeys).
set -euo pipefail

TOOL_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# habit-weekly → scripts/dev → scripts → repo root
repo_root="$(cd "$TOOL_HOME/../../.." && pwd)"
habit_sh="$repo_root/scripts/dev/habit-report.sh"
render_py="$TOOL_HOME/render.py"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/wsl-runtime-paths-lib.sh" 2>/dev/null || true

week='this'
since=''
until=''
write=0
stdout=0
json_only=0
providers='claude,grok,codex'
out_dir="${WSL_WORKFLOW_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/state/workflow}/habit-weekly"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
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
    --stdout) stdout=1; shift ;;
    --json-only) json_only=1; shift ;;
    --out-dir) out_dir="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null 2>&1 || { echo 'python3 required' >&2; exit 1; }
[[ -x "$habit_sh" || -f "$habit_sh" ]] || { printf 'missing %s\n' "$habit_sh" >&2; exit 1; }
[[ -f "$render_py" ]] || { printf 'missing %s\n' "$render_py" >&2; exit 1; }

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

bash "$habit_sh" \
  --days "$days" \
  --end "$until" \
  --providers "$providers" \
  --json \
  >"$json_path"

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

if (( write )); then
  mkdir -p "$out_dir"
  stem="habit-weekly-${since}_to_${until}"
  cp -f "$json_path" "$out_dir/${stem}.json"
  cp -f "$md_path" "$out_dir/${stem}.md"
  printf 'wrote %s\n' "$out_dir/${stem}.md" >&2
  printf 'wrote %s\n' "$out_dir/${stem}.json" >&2
  # Default: also print path; print body if --stdout
  if (( stdout )); then
    cat "$md_path"
  else
    printf '%s\n' "$out_dir/${stem}.md"
  fi
  exit 0
fi

# No --write: print markdown to stdout (agent can relay / save elsewhere).
cat "$md_path"
