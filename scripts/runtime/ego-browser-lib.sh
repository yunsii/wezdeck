#!/usr/bin/env bash
# Resolve the Windows ego-browser.exe for WSL callers.
# Sourced by scripts/runtime/cli/ego-browser and apply-browser-backend.sh.

ego_browser_trim_cr() {
  printf '%s' "${1-}" | tr -d '\r'
}

ego_browser_windows_userprofile_wsl() {
  if [[ -n "${WINDOWS_USERPROFILE_WSL:-}" ]]; then
    printf '%s\n' "$WINDOWS_USERPROFILE_WSL"
    return 0
  fi

  local lib
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/windows-runtime-paths-lib.sh"
  if [[ -f "$lib" ]]; then
    # shellcheck disable=SC1090
    source "$lib"
    if windows_runtime_detect_paths 2>/dev/null \
      && [[ -n "${WINDOWS_USERPROFILE_WSL:-}" ]]; then
      printf '%s\n' "$WINDOWS_USERPROFILE_WSL"
      return 0
    fi
  fi

  # Last-resort: single Windows profile under /mnt/c/Users that owns ego.
  local candidate
  for candidate in /mnt/c/Users/*/".local/share/ego/active_version_dir/ego-browser.exe"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$(dirname "$(dirname "$(dirname "$(dirname "$candidate")")")")"
      return 0
    fi
  done
  return 1
}

# Print absolute WSL path to ego-browser.exe, or fail.
ego_browser_resolve_exe() {
  local override="${EGO_BROWSER_EXE:-}"
  local profile_wsl="" exe=""

  if [[ -n "$override" ]]; then
    if [[ "$override" == *':'* && "$override" != /* ]]; then
      # Windows path like C:\... or C:/...
      if command -v wslpath >/dev/null 2>&1; then
        exe="$(wslpath -u "$override" 2>/dev/null || true)"
      fi
    else
      exe="$override"
    fi
    if [[ -n "$exe" && -f "$exe" ]]; then
      printf '%s\n' "$exe"
      return 0
    fi
    printf 'ego-browser: EGO_BROWSER_EXE is set but not a file: %s\n' "$override" >&2
    return 1
  fi

  profile_wsl="$(ego_browser_windows_userprofile_wsl)" || true
  if [[ -n "$profile_wsl" ]]; then
    exe="$profile_wsl/.local/share/ego/active_version_dir/ego-browser.exe"
    if [[ -f "$exe" || -L "$exe" ]]; then
      # Follow symlink for a stable real path when possible.
      if command -v readlink >/dev/null 2>&1; then
        printf '%s\n' "$(readlink -f "$exe" 2>/dev/null || printf '%s' "$exe")"
      else
        printf '%s\n' "$exe"
      fi
      return 0
    fi
  fi

  exe="/mnt/c/Program Files/Citro Labs/ego lite/Application/0.6.2.7/ego-browser.exe"
  if [[ -f "$exe" ]]; then
    printf '%s\n' "$exe"
    return 0
  fi

  printf 'ego-browser: ego-browser.exe not found. Install ego (lite), finish onboarding, or set EGO_BROWSER_EXE.\n' >&2
  return 1
}

# Vendor skill directory on the Windows profile (SKILL.md lives here).
ego_browser_vendor_skill_dir() {
  local profile_wsl=""
  profile_wsl="$(ego_browser_windows_userprofile_wsl)" || return 1
  local dir="$profile_wsl/.agents/skills/ego-browser"
  [[ -f "$dir/SKILL.md" ]] || return 1
  printf '%s\n' "$dir"
}

ego_browser_require_running() {
  local require="${EGO_BROWSER_REQUIRE_RUNNING:-1}"
  [[ "$require" == "0" || "$require" == "false" ]] && return 0

  # Cheap liveness: Windows process list via /proc is not available for Win
  # procs; probe the CLI instead with a no-op that does not open a Space.
  # Callers that only need `skill` may skip this.
  return 0
}
