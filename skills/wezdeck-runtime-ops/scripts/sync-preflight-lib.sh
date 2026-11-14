#!/usr/bin/env bash
# sync-preflight-lib.sh
#
# Gates sync-runtime.sh runs before (and while) staging the runtime: the WSL
# -> Windows PowerShell interop probe and the two Lua checks. Unlike the
# advisory checks in sync-health-checks-lib.sh, these fail the sync. Sourced
# (do not execute).
#
# Requires from the caller: sync_trace, windows-shell-lib.sh, runtime-log-lib.sh,
# and the REPO_ROOT / target variables sync-runtime.sh sets up — resolved at
# call time, so this file only has to be sourced before the functions run.
#
# Public functions used by sync-runtime.sh:
#   check_windows_powershell_interop  → WSL can start powershell.exe for the target
#   run_lua_source_syntax_check       → luac -p over the source wezterm-x tree
#   run_lua_precheck                  → load the staged runtime under lua-precheck.lua

check_windows_powershell_interop() {
  local target_home="${1:?missing target home}"

  # A /mnt/<drive> target means the runtime is hosted by Windows. Verify the
  # WSL interop boundary before canary work starts; command -v alone is not
  # sufficient when binfmt_misc/WSLInterop is disabled.
  [[ "$target_home" =~ ^/mnt/[A-Za-z]/ ]] || return 0

  sync_trace "step=powershell-interop status=checking target_home=$target_home"
  if ! command -v powershell.exe >/dev/null 2>&1; then
    sync_trace "step=powershell-interop status=failed reason=missing_powershell"
    cat >&2 <<'EOF'
[sync] Windows target detected, but powershell.exe is not on PATH.
[sync] Restore WSL interop and Windows PATH integration in /etc/wsl.conf:

[interop]
enabled=true
appendWindowsPath=true

[sync] Then run `wsl --shutdown` from Windows and reopen WSL.
EOF
    return 1
  fi

  local probe_output=""
  if ! probe_output="$(powershell.exe -NoProfile -NonInteractive -Command '[Console]::Write("interop-ok")' 2>&1)"; then
    sync_trace "step=powershell-interop status=failed reason=unexecutable output=$(printf '%s' "$probe_output" | tr '\r\n' '  ' | cut -c1-180)"
    cat >&2 <<'EOF'
[sync] powershell.exe was found but could not execute (WSL interop is likely disabled).
[sync] Ensure /etc/wsl.conf contains:

[interop]
enabled=true
appendWindowsPath=true

[sync] Then run `wsl --shutdown` from Windows and reopen WSL before retrying sync.
EOF
    return 1
  fi

  sync_trace "step=powershell-interop status=completed"
}

run_lua_source_syntax_check() {
  # Pre-sync gate: byte-compile every *.lua under the source tree with
  # `luac -p` so a syntax error in any file (not just the ones constants.lua
  # transitively requires) aborts before rsync overwrites the Windows
  # runtime with a broken file. The post-copy lua-precheck only loads
  # constants.lua → it can't catch a busted titles.lua.
  local source_runtime_dir="${1:?missing source_runtime_dir}"

  local luac_bin=""
  for candidate in luac5.4 luac5.3 luac; do
    if command -v "$candidate" >/dev/null 2>&1; then
      luac_bin="$candidate"
      break
    fi
  done
  if [[ -z "$luac_bin" ]]; then
    sync_trace "step=lua-source-syntax status=skipped reason=no_luac"
    return 0
  fi

  sync_trace "step=lua-source-syntax status=running luac_bin=$luac_bin source_runtime_dir=$source_runtime_dir"

  local errors=""
  while IFS= read -r -d '' lua_file; do
    local err
    if ! err="$("$luac_bin" -p "$lua_file" 2>&1)"; then
      errors+="$err"$'\n'
    fi
  done < <(find "$source_runtime_dir" -type f -name '*.lua' -print0)

  if [[ -n "$errors" ]]; then
    runtime_log_error sync "lua source syntax check failed" "source_runtime_dir=$source_runtime_dir"
    sync_trace "step=lua-source-syntax status=failed source_runtime_dir=$source_runtime_dir"
    printf '[sync] lua syntax errors in source tree (sync aborted before copy):\n%s' "$errors" >&2
    return 1
  fi

  sync_trace "step=lua-source-syntax status=completed source_runtime_dir=$source_runtime_dir"
}

run_lua_precheck() {
  local target_runtime_dir="${1:?missing target_runtime_dir}"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local precheck_script="$script_dir/lua-precheck.lua"

  if [[ ! -f "$precheck_script" ]]; then
    sync_trace "step=lua-precheck status=skipped reason=script_missing precheck_script=$precheck_script"
    return 0
  fi

  # Skip-if-current: cache success as a touch'd sentinel under the runtime
  # state dir. As long as no input file (lua/, repo-worktree-task.env, the
  # precheck script itself) is newer than the sentinel, the prior result
  # is still valid. Override with WEZTERM_SYNC_FORCE_LUA_PRECHECK=1.
  # Canary and live use different sentinels so staging always re-checks the
  # canary tree even when live was prechecked recently.
  local sentinel_name="lua-precheck.ok"
  if [[ "${SYNC_PUBLISH_MODE:-live}" == "canary" ]]; then
    sentinel_name="lua-precheck.canary.ok"
  fi
  local sentinel="${TARGET_RUNTIME_STATE_DIR:-$target_runtime_dir/.state}/$sentinel_name"
  if [[ -f "$sentinel" && "${WEZTERM_SYNC_FORCE_LUA_PRECHECK:-0}" != "1" ]]; then
    local newer_input
    newer_input="$(find \
      "$target_runtime_dir/lua" \
      "$target_runtime_dir/repo-worktree-task.env" \
      "$precheck_script" \
      -newer "$sentinel" -print -quit 2>/dev/null)"
    if [[ -z "$newer_input" ]]; then
      sync_trace "step=lua-precheck status=skipped reason=up-to-date sentinel=$sentinel"
      return 0
    fi
  fi

  local lua_bin=""
  for candidate in lua5.4 lua5.3 lua; do
    if command -v "$candidate" >/dev/null 2>&1; then
      lua_bin="$candidate"
      break
    fi
  done

  if [[ -z "$lua_bin" ]]; then
    runtime_log_warn sync "skipped lua precheck after sync" "reason=no_lua_runtime"
    sync_trace "step=lua-precheck status=skipped reason=no_lua_runtime"
    printf 'Skipped lua precheck: install lua5.4 (`sudo apt install lua5.4`) to enable.\n' >&2
    return 0
  fi

  sync_trace "step=lua-precheck status=running lua_bin=$lua_bin target_runtime_dir=$target_runtime_dir"
  if ! "$lua_bin" "$precheck_script" "$target_runtime_dir"; then
    runtime_log_error sync "lua precheck failed" "target_runtime_dir=$target_runtime_dir"
    sync_trace "step=lua-precheck status=failed target_runtime_dir=$target_runtime_dir"
    return 1
  fi
  mkdir -p "$(dirname "$sentinel")" 2>/dev/null || true
  : >"$sentinel"
  sync_trace "step=lua-precheck status=completed target_runtime_dir=$target_runtime_dir sentinel=$sentinel"
}
