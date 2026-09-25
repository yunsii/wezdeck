param(
  [string]$StatePath = '',
  [string]$StatePath2 = '',
  [switch]$All
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'SilentlyContinue'

$targetPids = @()
foreach ($path in @($StatePath, $StatePath2)) {
  if (-not (Test-Path -LiteralPath $path)) {
    continue
  }
  foreach ($line in @(Get-Content -LiteralPath $path)) {
    if ($line -match '^pid=([0-9]+)$') {
      $targetPids += [int]$Matches[1]
    }
  }
}

$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'helper-manager.exe'
})
$killPids = if ($All) {
  @($processes.ProcessId)
} else {
  @($targetPids)
}

$stopped = 0
foreach ($targetPid in ($killPids | Select-Object -Unique)) {
  if ([int]$targetPid -le 0) {
    continue
  }
  if (Stop-Process -Id ([int]$targetPid) -Force -PassThru -ErrorAction SilentlyContinue) {
    $stopped++
  }
}

Write-Output ("stopped=" + $stopped)
