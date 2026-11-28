# Windows-owned worker. All state after CompactVirtualDisk begins stays on NTFS.
param(
  [Parameter(Mandatory)][string]$Distro,
  [Parameter(Mandatory)][string]$Vhdx,
  [Parameter(Mandatory)][string]$KeepaliveTask,
  [Parameter(Mandatory)][string]$WslUser,
  [Parameter(Mandatory)][string]$VerifyScript,
  [Parameter(Mandatory)][string]$WebOrigin,
  [Parameter(Mandatory)][string]$StatusPath,
  [string]$StartSignalPath,
  [switch]$Simulate,
  [switch]$PreflightOnly
)
$ErrorActionPreference = 'Stop'
$status = [ordered]@{ phase = 'preflight'; started_at = (Get-Date).ToString('o'); distro = $Distro; vhdx = $Vhdx }
$stopAttempted = $false
function Assert-Preflight {
  if (-not (Test-Path -LiteralPath $Vhdx -PathType Leaf)) { throw "VHDX not found: $Vhdx" }
  $registered = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' |
    Get-ItemProperty | Where-Object { $_.DistributionName -eq $Distro })
  if ($registered.Count -ne 1) { throw "WSL distro not uniquely registered: $Distro" }
  $base = $registered[0].BasePath
  if ($base.StartsWith('\\?\')) { $base = $base.Substring(4) }
  $expected = Join-Path $base 'ext4.vhdx'
  if (-not [string]::Equals($expected, $Vhdx, [StringComparison]::OrdinalIgnoreCase)) {
    throw "VHDX does not match registered distro path: $expected"
  }
  $task = Get-ScheduledTask -TaskName $KeepaliveTask -ErrorAction SilentlyContinue
  if (-not $task) { throw "Keepalive task missing: $KeepaliveTask" }
}
function Publish {
  $status.updated_at = (Get-Date).ToString('o')
  $temp = "$StatusPath.tmp.$PID"
  [System.IO.File]::WriteAllText($temp, ($status | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $StatusPath -Force
}
if ($PreflightOnly) {
  Assert-Preflight
  Write-Output 'windows_preflight=ok'
  exit 0
}
try {
  Assert-Preflight
  $drive = (Split-Path -Qualifier $Vhdx).TrimEnd(':')
  $status.before_free_bytes = (Get-PSDrive -Name $drive).Free
  $status.before_vhdx_bytes = (Get-Item -LiteralPath $Vhdx).Length
  Publish

  if (-not $StartSignalPath) { throw 'start signal path missing' }
  $signalDeadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath $StartSignalPath)) {
    if ((Get-Date) -ge $signalDeadline) { throw 'start signal timed out; WSL was not stopped' }
    Start-Sleep -Milliseconds 250
  }
  Remove-Item -LiteralPath $StartSignalPath -Force
  if ($Simulate) {
    $status.phase = 'verifying'; Publish
    $verify = & wsl.exe --distribution $Distro --user $WslUser --exec /bin/bash $VerifyScript $WebOrigin 2>&1 | Out-String
    $status.verify_output = $verify.Trim()
    $status.verify_exit = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw 'smoke verification failed' }
    $status.after_free_bytes = (Get-PSDrive -Name $drive).Free
    $status.after_vhdx_bytes = (Get-Item -LiteralPath $Vhdx).Length
    $status.phase = 'complete'; Publish
    exit 0
  }
  # Give the caller time to print the handoff result and exit WSL.
  Start-Sleep -Seconds 5
  $status.phase = 'compacting'; Publish
  $stopAttempted = $true
  $output = & wsl.exe --manage $Distro --compact 2>&1 | Out-String
  $status.compact_output = $output.Trim()
  $status.compact_exit = $LASTEXITCODE
  $status.after_free_bytes = (Get-PSDrive -Name $drive).Free
  $status.after_vhdx_bytes = (Get-Item -LiteralPath $Vhdx).Length
  if ($LASTEXITCODE -ne 0) { throw "WSL compact failed: $LASTEXITCODE" }
  $status.phase = 'restarting'; Publish

  $task = Get-ScheduledTask -TaskName $KeepaliveTask -ErrorAction SilentlyContinue
  if (-not $task) { throw "Keepalive task missing: $KeepaliveTask" }
  if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $KeepaliveTask }

  $deadline = (Get-Date).AddMinutes(4)
  do {
    Start-Sleep -Seconds 5
    $verify = & wsl.exe --distribution $Distro --user $WslUser --exec /bin/bash $VerifyScript $WebOrigin 2>&1 | Out-String
    $verifyExit = $LASTEXITCODE
  } until ($verifyExit -eq 0 -or (Get-Date) -ge $deadline)
  $status.verify_output = $verify.Trim()
  $status.verify_exit = $verifyExit
  if ($verifyExit -ne 0) { throw 'WSL services or web relay did not recover within 4 minutes' }
  $status.phase = 'complete'; Publish
} catch {
  $originalError = $_.Exception.Message
  if ($stopAttempted) {
    try {
      $task = Get-ScheduledTask -TaskName $KeepaliveTask -ErrorAction SilentlyContinue
      if ($task -and $task.State -ne 'Running') { Start-ScheduledTask -TaskName $KeepaliveTask }
      & wsl.exe --distribution $Distro --user $WslUser --exec /bin/true 2>&1 | Out-Null
      $status.restart_attempt_exit = $LASTEXITCODE
    } catch {
      $status.restart_error = $_.Exception.Message
    }
  }
  $status.phase = 'failed'
  $status.error = $originalError
  Publish
  exit 1
}
