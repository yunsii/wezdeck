#!/usr/bin/env bash
# Ctrl+k e / windows.restart-explorer — restart Windows Explorer (shell).
#
# Typical trigger: after lock→unlock the shell gets stuck — auto-hide hover
# dies (Win/Meta still works), and/or a "maximized" WezTerm grows to the full
# screen bounds and covers the taskbar band (working area ignored).
#
# Steps:
#   1. Recycle explorer.exe (+ ShellExperienceHost / StartMenuExperienceHost /
#      SearchHost) and verify a new PID.
#   2. When auto-hide is off, re-fit any wezterm-gui window whose bottom edge
#      covers the tray into the primary working area (restore → place → maximize).
#
# Does NOT flip the auto-hide setting (StuckRects3 byte8 encoding varies by
# build). Use Settings → Taskbar behaviors for that.
#
# Outcome contract: toast + runtime.log invoked → completed|failed (duration_ms).
# stdout MUST stay empty for run-shell (view-mode / status COPY risk).
# Always exit 0 from the hotkey wrapper so tmux does not append "returned N".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/windows-shell-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="restart-windows-explorer.sh"

toast() {
  local msg="${1:-}"
  msg="${msg//$'\n'/ }"
  if ((${#msg} > 120)); then
    msg="${msg:0:117}..."
  fi
  tmux display-message -d 3000 "$msg" 2>/dev/null || true
}

start_ms="$(runtime_log_now_ms)"
common_fields=(
  "hotkey_id=windows.restart-explorer"
)

runtime_log_info workspace "windows explorer restart invoked" "${common_fields[@]}"

if [[ -z "${WSL_DISTRO_NAME:-}" ]] || ! command -v powershell.exe >/dev/null 2>&1; then
  duration_ms="$(runtime_log_duration_ms "$start_ms")"
  toast_msg='Restart Explorer: hybrid-wsl / powershell.exe required.'
  runtime_log_warn workspace "windows explorer restart failed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "error=not_hybrid_wsl" \
    "toast=$toast_msg"
  toast "$toast_msg"
  exit 0
fi

ps_body='
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ExplorerRestartProbe {
  [DllImport("shell32.dll")] public static extern IntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA {
    public uint cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam;
  }
  public static readonly IntPtr HWND_TOP = IntPtr.Zero;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const int GWL_STYLE = -16;
  public const int WS_CAPTION = 0x00C00000;
  public const int WS_THICKFRAME = 0x00040000;
  public const int SW_RESTORE = 9;
  public const int SW_MAXIMIZE = 3;
}
"@

$before = @(Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process ShellExperienceHost,StartMenuExperienceHost,SearchHost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 700
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }
$deadline = (Get-Date).AddSeconds(8)
do { Start-Sleep -Milliseconds 200 } while (-not (Get-Process explorer -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline))
Start-Sleep -Milliseconds 500

$afterProcs = @(Get-Process explorer -ErrorAction SilentlyContinue)
$after = @($afterProcs | ForEach-Object { $_.Id })
$newIds = @($after | Where-Object { $before -notcontains $_ })
$ok = ($newIds.Count -gt 0) -or (($before.Count -eq 0) -and ($after.Count -gt 0))

$abd = New-Object ExplorerRestartProbe+APPBARDATA
$abd.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($abd)
$abm = 0
try { $abm = [int][ExplorerRestartProbe]::SHAppBarMessage(4, [ref]$abd).ToInt64() } catch { $abm = -1 }
$autohideOn = (($abm -band 1) -ne 0)
$autohide = if ($autohideOn) { "on" } else { "off" }
$start = if ($afterProcs.Count -gt 0) { $afterProcs[0].StartTime.ToString("HH:mm:ss") } else { "none" }
$pidOut = if ($after.Count -gt 0) { ($after -join ",") } else { "none" }

$healed = 0
if (-not $autohideOn) {
  $tray = [ExplorerRestartProbe]::FindWindow("Shell_TrayWnd", $null)
  $trayRect = New-Object ExplorerRestartProbe+RECT
  if ($tray -ne [IntPtr]::Zero) { [void][ExplorerRestartProbe]::GetWindowRect($tray, [ref]$trayRect) }
  Add-Type -AssemblyName System.Windows.Forms
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  Get-Process wezterm-gui -ErrorAction SilentlyContinue | ForEach-Object {
    $h = [IntPtr]$_.MainWindowHandle
    if ($h -eq [IntPtr]::Zero) { return }
    $wr = New-Object ExplorerRestartProbe+RECT
    [void][ExplorerRestartProbe]::GetWindowRect($h, [ref]$wr)
    $covers = ($tray -ne [IntPtr]::Zero) -and ($wr.Bottom -ge $trayRect.Top) -and ($wr.Top -le 0) -and (($wr.Bottom - $wr.Top) -gt $wa.Height)
    if (-not $covers) { return }
    $style = [ExplorerRestartProbe]::GetWindowLongPtr($h, [ExplorerRestartProbe]::GWL_STYLE).ToInt64()
    $style = $style -bor [ExplorerRestartProbe]::WS_CAPTION -bor [ExplorerRestartProbe]::WS_THICKFRAME
    [void][ExplorerRestartProbe]::ShowWindow($h, [ExplorerRestartProbe]::SW_RESTORE)
    Start-Sleep -Milliseconds 150
    [void][ExplorerRestartProbe]::SetWindowLongPtr($h, [ExplorerRestartProbe]::GWL_STYLE, [IntPtr]$style)
    [void][ExplorerRestartProbe]::SetWindowPos($h, [ExplorerRestartProbe]::HWND_TOP, $wa.X, $wa.Y, $wa.Width, $wa.Height, ([ExplorerRestartProbe]::SWP_FRAMECHANGED -bor [ExplorerRestartProbe]::SWP_SHOWWINDOW))
    Start-Sleep -Milliseconds 150
    [void][ExplorerRestartProbe]::ShowWindow($h, [ExplorerRestartProbe]::SW_MAXIMIZE)
    $healed++
  }
}

Write-Output ("ok=" + $ok + " pid=" + $pidOut + " start=" + $start + " autohide=" + $autohide + " wezterm_healed=" + $healed + " before=" + (($before -join ",") -replace "^$","none"))
'

ec=0
ps_out=""
ps_out="$(windows_run_powershell_command_utf8 "$ps_body" 2>&1)" || ec=$?
duration_ms="$(runtime_log_duration_ms "$start_ms")"
status_line="$(printf '%s\n' "$ps_out" | tr -d '\r' | grep -E '^ok=' | tail -n 1 || true)"

ok=""
new_pid=""
start_t=""
autohide=""
wezterm_healed=""
if [[ -n "$status_line" ]]; then
  [[ "$status_line" =~ ok=([^ ]+) ]] && ok="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ pid=([^ ]+) ]] && new_pid="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ start=([^ ]+) ]] && start_t="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ autohide=([^ ]+) ]] && autohide="${BASH_REMATCH[1]}"
  [[ "$status_line" =~ wezterm_healed=([^ ]+) ]] && wezterm_healed="${BASH_REMATCH[1]}"
fi

if ((ec != 0)) || [[ "$ok" != "True" && "$ok" != "true" ]]; then
  toast_msg="Restart Explorer failed (exit ${ec}; ok=${ok:-?})."
  runtime_log_warn workspace "windows explorer restart failed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "exit_code=$ec" \
    "status=${status_line:-}" \
    "toast=$toast_msg" \
    "stderr=${ps_out//$'\n'/ }"
  toast "$toast_msg"
  exit 0
fi

toast_msg="Explorer ok (pid ${new_pid} @ ${start_t}; autohide ${autohide}"
if [[ -n "${wezterm_healed}" && "${wezterm_healed}" != "0" ]]; then
  toast_msg+=", wezterm healed ${wezterm_healed}"
fi
toast_msg+=")."

runtime_log_info workspace "windows explorer restart completed" \
  "${common_fields[@]}" \
  "duration_ms=$duration_ms" \
  "explorer_pid=${new_pid}" \
  "explorer_start=${start_t}" \
  "autohide=${autohide}" \
  "wezterm_healed=${wezterm_healed:-0}" \
  "toast=$toast_msg"
toast "$toast_msg"
exit 0
