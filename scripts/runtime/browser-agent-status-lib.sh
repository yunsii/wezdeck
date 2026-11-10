#!/usr/bin/env bash
# Read/write Windows-side browser-agent status for the WezTerm right-status
# badge and Alt+b dispatch. File lives on the helper FS (same rule as
# chrome-debug / disk-guard) so Lua never crosses \\wsl$ on the 250 ms tick.
#
# Schema (state/browser-agent/status.json):
#   {
#     "backend": "ego"|"cdp",
#     "updated_at_ms": <int>,
#     "ego": { "alive": <bool>, "updated_at_ms": <int>, "exe": "<win path>" }
#   }

browser_agent_status_dir() {
  if [[ -z "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    local lib
    lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/windows-runtime-paths-lib.sh"
    # shellcheck disable=SC1090
    source "$lib"
    windows_runtime_detect_paths || return 1
  fi
  printf '%s/state/browser-agent\n' "$WINDOWS_RUNTIME_STATE_WSL"
}

browser_agent_status_file() {
  local dir
  dir="$(browser_agent_status_dir)" || return 1
  printf '%s/status.json\n' "$dir"
}

browser_agent_now_ms() {
  if [[ -n "${EPOCHREALTIME-}" && "$EPOCHREALTIME" == *.* ]]; then
    awk -v t="$EPOCHREALTIME" 'BEGIN { printf "%d", t * 1000 }'
  else
    date +%s%3N
  fi
}

browser_agent_ego_exe_win() {
  if [[ -n "${EGO_BROWSER_APP_EXE:-}" ]]; then
    printf '%s\n' "$EGO_BROWSER_APP_EXE"
    return 0
  fi
  # Default install layout (versioned Application dir is behind ego.exe shim).
  printf '%s\n' 'C:\Program Files\Citro Labs\ego lite\Application\ego.exe'
}

browser_agent_probe_ego_alive() {
  local lib
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/windows-shell-lib.sh"
  # shellcheck disable=SC1090
  source "$lib"
  local count
  count="$(windows_run_powershell_command_utf8 \
    "(Get-Process -Name ego -ErrorAction SilentlyContinue | Measure-Object).Count" \
    2>/dev/null | tr -d '\r' | tail -n1)"
  [[ "${count:-0}" =~ ^[0-9]+$ ]] || count=0
  ((count > 0))
}

# Usage: browser_agent_status_write --backend ego|cdp [--ego-alive 0|1] [--probe-ego]
browser_agent_status_write() {
  local backend="" ego_alive="" probe_ego=0
  while (($#)); do
    case "$1" in
      --backend) backend="${2:-}"; shift 2 ;;
      --ego-alive) ego_alive="${2:-}"; shift 2 ;;
      --probe-ego) probe_ego=1; shift ;;
      *)
        printf 'browser_agent_status_write: unknown arg %s\n' "$1" >&2
        return 2
        ;;
    esac
  done

  local file dir now existing
  file="$(browser_agent_status_file)" || return 1
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  now="$(browser_agent_now_ms)"

  existing=""
  if [[ -f "$file" ]]; then
    existing="$(cat "$file" 2>/dev/null || true)"
  fi

  if [[ -z "$backend" && -n "$existing" ]]; then
    backend="$(printf '%s' "$existing" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("backend",""))' 2>/dev/null || true)"
  fi
  if [[ -z "$backend" ]]; then
    backend="${WEZDECK_BROWSER_BACKEND:-cdp}"
  fi
  case "$backend" in
    ego|cdp) ;;
    *) backend=cdp ;;
  esac

  if ((probe_ego)); then
    if browser_agent_probe_ego_alive; then
      ego_alive=1
    else
      ego_alive=0
    fi
  fi

  local prev_ego_alive="false" prev_ego_ms="$now" exe
  exe="$(browser_agent_ego_exe_win)"
  if [[ -n "$existing" ]]; then
    local parsed
    parsed="$(printf '%s' "$existing" | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin)
  e=d.get("ego") or {}
  print(("true" if e.get("alive") else "false") + " " + str(int(e.get("updated_at_ms") or 0)) + " " + str(e.get("exe") or ""))
except Exception:
  print("false 0 ")
' 2>/dev/null || true)"
    prev_ego_alive="$(printf '%s' "$parsed" | awk '{print $1}')"
    prev_ego_ms="$(printf '%s' "$parsed" | awk '{print $2}')"
    local prev_exe
    prev_exe="$(printf '%s' "$parsed" | awk '{print substr($0, index($0,$3))}')"
    [[ -n "$prev_exe" ]] && exe="$prev_exe"
  fi

  local alive_json="false" ego_ms="$prev_ego_ms"
  if [[ -n "$ego_alive" ]]; then
    if [[ "$ego_alive" == "1" || "$ego_alive" == "true" ]]; then
      alive_json="true"
    else
      alive_json="false"
    fi
    ego_ms="$now"
  else
    alive_json="$prev_ego_alive"
  fi

  local tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
{
  "backend": "$backend",
  "updated_at_ms": $now,
  "ego": {
    "alive": $alive_json,
    "updated_at_ms": $ego_ms,
    "exe": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$exe")
  }
}
EOF
  mv -f "$tmp" "$file"
  printf '%s\n' "$file"
}
