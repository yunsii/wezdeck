param(
  [Parameter(Mandatory = $true)]
  [string]$TargetHome,

  [Parameter(Mandatory = $true)]
  [string]$CurrentRelease
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$runtimeRoot = Join-Path $TargetHome '.wezterm-runtime'
$releasesRoot = Join-Path $runtimeRoot 'releases'
$currentReleaseRoot = Join-Path $releasesRoot $CurrentRelease
$scriptNames = @(
  'windows-runtime-helper.ps1',
  'clipboard-image-listener.ps1'
)

if (-not (Test-Path -LiteralPath $releasesRoot)) {
  Write-Output '0'
  exit 0
}

$killedCount = 0
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
  $commandLine = [string]$_.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $false
  }

  if (-not $commandLine.Contains($releasesRoot)) {
    return $false
  }

  if ($commandLine.Contains($currentReleaseRoot)) {
    return $false
  }

  foreach ($scriptName in $scriptNames) {
    if ($commandLine.Contains($scriptName)) {
      return $true
    }
  }

  return $false
})

foreach ($process in $processes) {
  try {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    $killedCount += 1
  } catch {
    # Keep going so one stale process does not block the rest.
  }
}

Write-Output $killedCount
