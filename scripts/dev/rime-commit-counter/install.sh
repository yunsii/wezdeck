#!/usr/bin/env bash
# Install WezDeck Rime commit counter into the Windows Weasel user dir.
#
# Copies lua module + patches double_pinyin_flypy.custom.yaml, ensures the
# JSONL state directory exists. Does NOT auto-run WeaselDeployer (user must
# 重新部署 once).
set -euo pipefail

TOOL_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TOOL_HOME/../../.." && pwd)"

# Prefer explicit env; else common WSL mounts (avoid cmd.exe — may be blocked
# in agent shells). Fall back to windows-runtime-paths-lib when available.
RIME_USER="${WEZDECK_RIME_USER_DIR:-}"
STATE_DIR="${WEZDECK_RIME_STATE_DIR:-}"
if [[ -z "$RIME_USER" || -z "$STATE_DIR" ]]; then
  for user in yuns Yuns; do
    cand="/mnt/c/Users/$user/AppData/Roaming/Rime"
    state_cand="/mnt/c/Users/$user/AppData/Local/wezterm-runtime/state"
    if [[ -z "$RIME_USER" && -d "$cand" ]]; then
      RIME_USER="$cand"
    fi
    if [[ -z "$STATE_DIR" && -d "$(dirname "$state_cand")" ]]; then
      STATE_DIR="$state_cand"
    fi
  done
fi
if [[ -z "$RIME_USER" || -z "$STATE_DIR" ]]; then
  # shellcheck source=/dev/null
  . "$REPO_ROOT/scripts/runtime/windows-runtime-paths-lib.sh"
  if windows_runtime_detect_paths; then
    RIME_USER="${RIME_USER:-$WINDOWS_USERPROFILE_WSL/AppData/Roaming/Rime}"
    STATE_DIR="${STATE_DIR:-$WINDOWS_RUNTIME_STATE_WSL/state}"
  fi
fi
[[ -n "$RIME_USER" && -n "$STATE_DIR" ]] || {
  echo "install: cannot resolve Rime user dir / wezterm-runtime state" >&2
  exit 1
}

SCHEMA_CUSTOM="${WEZDECK_RIME_SCHEMA_CUSTOM:-$RIME_USER/double_pinyin_flypy.custom.yaml}"
LUA_DST="$RIME_USER/lua/wezdeck_commit_counter.lua"
LUA_SRC="$TOOL_HOME/wezdeck_commit_counter.lua"
LOG_FILE="$STATE_DIR/rime-commits.jsonl"
PATCH_LINE='  engine/processors/@before 0: lua_processor@*wezdeck_commit_counter'

[[ -d "$RIME_USER" ]] || {
  printf 'install: Rime user dir missing: %s\n' "$RIME_USER" >&2
  exit 1
}
[[ -f "$LUA_SRC" ]] || {
  printf 'install: missing %s\n' "$LUA_SRC" >&2
  exit 1
}

mkdir -p "$RIME_USER/lua" "$STATE_DIR"
cp -f "$LUA_SRC" "$LUA_DST"
touch "$LOG_FILE"

if [[ ! -f "$SCHEMA_CUSTOM" ]]; then
  cat >"$SCHEMA_CUSTOM" <<EOF
patch:
  schema/name: 小鹤双拼
$PATCH_LINE
EOF
  echo "install: created $SCHEMA_CUSTOM"
else
  if grep -q 'wezdeck_commit_counter' "$SCHEMA_CUSTOM"; then
    echo "install: schema custom already patched"
  else
    if grep -q '^patch:' "$SCHEMA_CUSTOM"; then
      # Insert processor line after `patch:`
      python3 - "$SCHEMA_CUSTOM" "$PATCH_LINE" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
line = sys.argv[2]
text = path.read_text(encoding="utf-8")
if "wezdeck_commit_counter" in text:
    raise SystemExit(0)
out = []
inserted = False
for raw in text.splitlines(keepends=True):
    out.append(raw)
    if not inserted and raw.strip() == "patch:":
        out.append(line + "\n")
        inserted = True
if not inserted:
    if not text.endswith("\n"):
        out.append("\n")
    out.append("patch:\n")
    out.append(line + "\n")
path.write_text("".join(out), encoding="utf-8")
PY
    else
      printf '\npatch:\n%s\n' "$PATCH_LINE" >>"$SCHEMA_CUSTOM"
    fi
    echo "install: patched $SCHEMA_CUSTOM"
  fi
fi

# Fast activate: patch build schema + restart WeaselServer.
# Full WeaselDeployer /deploy on rime-ice often hangs minutes and returns -1;
# custom.yaml keeps the lasting patch for the next successful UI deploy.
echo "install: patching build schema + restarting WeaselServer (skip full /deploy)…"
BUILD_SCHEMA="$RIME_USER/build/double_pinyin_flypy.schema.yaml"
if [[ -f "$BUILD_SCHEMA" ]]; then
  python3 - "$BUILD_SCHEMA" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding="utf-8")
if "wezdeck_commit_counter" in text:
    print("build: already has counter")
    raise SystemExit(0)
for needle, insert in (
    (
        '  processors:\n    - "lua_processor@*select_character"',
        '  processors:\n    - "lua_processor@*wezdeck_commit_counter"\n    - "lua_processor@*select_character"',
    ),
    (
        "  processors:\n    - lua_processor@*select_character",
        "  processors:\n    - lua_processor@*wezdeck_commit_counter\n    - lua_processor@*select_character",
    ),
):
    if needle in text:
        p.write_text(text.replace(needle, insert, 1), encoding="utf-8")
        print("build: patched")
        raise SystemExit(0)
print("build: processors anchor not found", file=sys.stderr)
raise SystemExit(1)
PY
else
  echo "install: warn: missing $BUILD_SCHEMA (open 小狼毫重新部署 once to generate build/)" >&2
fi

# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/runtime/windows-shell-lib.sh"
windows_run_powershell_command_utf8 '
$ErrorActionPreference = "Stop"
Get-Process WeaselDeployer -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$icon = (
  Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*,
                   HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match "小狼毫|Weasel" -and $_.DisplayIcon } |
    Select-Object -First 1 -ExpandProperty DisplayIcon
)
if (-not $icon) { throw "Weasel DisplayIcon not in Uninstall registry" }
$dir = Split-Path -Parent ($icon.Trim("`""))
$server = Join-Path $dir "WeaselServer.exe"
Get-Process WeaselServer -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Start-Process -FilePath $server -WorkingDirectory $dir
Start-Sleep -Seconds 1
if (-not (Get-Process WeaselServer -ErrorAction SilentlyContinue)) { throw "WeaselServer failed to start" }
Write-Output ("server_restarted dir=" + $dir)
'

cat <<EOF
install: ok
  lua:    $LUA_DST
  custom: $SCHEMA_CUSTOM
  build:  $BUILD_SCHEMA
  log:    $LOG_FILE

Type Chinese in WezTerm; lines should append to the log.
Join with: python3 scripts/dev/habit-report.py --days 7
EOF
