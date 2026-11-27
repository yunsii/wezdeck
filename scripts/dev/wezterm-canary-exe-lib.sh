#!/usr/bin/env bash
# Resolve the installed Windows WezTerm without depending on the agent shell's
# PATH, which often contains no Windows entries.

wezterm_exe_from_install_record() {
  declare -F windows_run_powershell_command_utf8 >/dev/null || return 1
  command -v wslpath >/dev/null 2>&1 || return 1

  local win_path="" wsl_path=""
  win_path="$(windows_run_powershell_command_utf8 '
$keys = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
foreach ($entry in (Get-ItemProperty $keys -ErrorAction SilentlyContinue)) {
  if ($entry.DisplayName -notmatch "^WezTerm") { continue }
  if (-not $entry.InstallLocation) { continue }
  $candidate = Join-Path $entry.InstallLocation "wezterm.exe"
  if (Test-Path -LiteralPath $candidate) { Write-Output $candidate; break }
}' 2>/dev/null)" || return 1
  win_path="${win_path%%$'\n'*}"
  win_path="${win_path%$'\r'}"
  [[ -n "$win_path" ]] || return 1
  wsl_path="$(wslpath -u "$win_path" 2>/dev/null)" || return 1
  [[ -f "$wsl_path" ]] || return 1
  printf '%s\n' "$wsl_path"
}

find_wezterm_exe() {
  local candidate=""
  candidate="$(command -v wezterm.exe 2>/dev/null || true)"
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if candidate="$(wezterm_exe_from_install_record)"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  for candidate in \
    "/mnt/c/Program Files/WezTerm/wezterm.exe" \
    "/mnt/c/Program Files/WezTerm/wezterm-gui.exe" \
    "${WINDOWS_USERPROFILE_WSL:-}/scoop/apps/wezterm/current/wezterm.exe" \
    "${WINDOWS_USERPROFILE_WSL:-}/AppData/Local/Programs/WezTerm/wezterm.exe" \
    "${WINDOWS_USERPROFILE_WSL:-}/AppData/Local/Microsoft/WinGet/Packages"/*/WezTerm*/wezterm.exe
  do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  if command -v wezterm >/dev/null 2>&1; then
    command -v wezterm
    return 0
  fi
  return 1
}
