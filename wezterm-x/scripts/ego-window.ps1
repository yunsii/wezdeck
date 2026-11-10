#Requires -Version 5.1
# Alt+b / Alt+Shift+b ego backend: ensure ego (lite) is running, optionally focus.
#
# Usage:
#   ego-window.ps1 -Ensure              # start if needed; do not activate
#   ego-window.ps1 -Focus               # start if needed; activate main window
#   ego-window.ps1 -Ensure -StatusFile <path>
param(
  [switch]$Ensure,
  [switch]$Focus,
  [string]$Exe = 'C:\Program Files\Citro Labs\ego lite\Application\ego.exe',
  [string]$StatusFile = ''
)

$ErrorActionPreference = 'Stop'

function Get-EgoProcesses {
  Get-Process -Name ego -ErrorAction SilentlyContinue
}

function Write-BrowserAgentStatus {
  param(
    [bool]$Alive,
    [string]$Backend = 'ego'
  )
  if ([string]::IsNullOrWhiteSpace($StatusFile)) {
    return
  }
  $dir = Split-Path -Parent $StatusFile
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $obj = [ordered]@{
    backend        = $Backend
    updated_at_ms  = $now
    ego            = [ordered]@{
      alive          = $Alive
      updated_at_ms  = $now
      exe            = $Exe
    }
  }
  $json = ($obj | ConvertTo-Json -Compress -Depth 5)
  $tmp = "$StatusFile.tmp.$PID"
  [System.IO.File]::WriteAllText($tmp, $json)
  Move-Item -LiteralPath $tmp -Destination $StatusFile -Force
}

function Start-EgoIfNeeded {
  $procs = @(Get-EgoProcesses)
  if ($procs.Count -gt 0) {
    return $procs
  }
  if (-not (Test-Path -LiteralPath $Exe)) {
    throw "ego.exe not found: $Exe"
  }
  Start-Process -FilePath $Exe | Out-Null
  Start-Sleep -Milliseconds 800
  return @(Get-EgoProcesses)
}

function Focus-EgoWindow {
  param([System.Diagnostics.Process[]]$Procs)
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EgoNative {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  public const int SW_RESTORE = 9;
}
'@ -ErrorAction SilentlyContinue

  foreach ($p in $Procs) {
    try {
      $p.Refresh()
      $hwnd = $p.MainWindowHandle
      if ($hwnd -ne [IntPtr]::Zero) {
        [EgoNative]::ShowWindowAsync($hwnd, [EgoNative]::SW_RESTORE) | Out-Null
        [EgoNative]::SetForegroundWindow($hwnd) | Out-Null
        return $true
      }
    } catch {
      # try next process
    }
  }
  return $false
}

if (-not $Ensure -and -not $Focus) {
  $Ensure = $true
}

$procs = Start-EgoIfNeeded
$alive = (@(Get-EgoProcesses).Count -gt 0)
Write-BrowserAgentStatus -Alive:$alive -Backend ego

if ($Focus) {
  $focused = Focus-EgoWindow -Procs $procs
  if (-not $focused) {
    # MainWindowHandle can lag just after start; one retry.
    Start-Sleep -Milliseconds 700
    $procs = @(Get-EgoProcesses)
    Focus-EgoWindow -Procs $procs | Out-Null
  }
}

Write-Output ("ego alive={0} focus={1}" -f $alive, [bool]$Focus)
