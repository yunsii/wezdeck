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
  [int]$ActiveAttention = 0,
  [int]$SnapshotWindows = 0,
  [string]$TaskId = '',
  [string]$TargetDevice = '',
  [switch]$TrimGuest,
  [switch]$Simulate,
  [switch]$PreflightOnly
)
$ErrorActionPreference = 'Stop'
$status = [ordered]@{
  phase = 'preflight'; started_at = (Get-Date).ToString('o'); distro = $Distro; vhdx = $Vhdx
  active_attention = $ActiveAttention; snapshot_windows = $SnapshotWindows
  task_id = $TaskId; target_device = $TargetDevice
  history = @(); last_phase = ''
}
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
  if ($status.last_phase -ne $status.phase) {
    $status.history += @{ phase = $status.phase; at = $status.updated_at }
    $status.last_phase = $status.phase
  }
  $status.duration_seconds = [math]::Round(((Get-Date) - [datetime]$status.started_at).TotalSeconds, 1)
  $temp = "$StatusPath.tmp.$PID"
  [System.IO.File]::WriteAllText($temp, ($status | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $StatusPath -Force
}
function Invoke-Wsl([string[]]$Arguments) {
  # PowerShell 5.1 turns native stderr into terminating ErrorRecords under
  # Stop. Capture both streams and the native exit code before restoring it.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & wsl.exe @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{ Output = $output.Trim(); Exit = $exitCode }
  } finally {
    $ErrorActionPreference = $previous
  }
}
if ($PreflightOnly) {
  Assert-Preflight
  if ($TrimGuest) {
    $rootCheck = Invoke-Wsl @('--distribution', $Distro, '--user', 'root', '--exec', '/usr/bin/id', '-u')
    if ($rootCheck.Exit -ne 0 -or $rootCheck.Output -ne '0') { throw 'WSL root fstrim capability unavailable' }
  }
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
  if ($TrimGuest -and -not $Simulate) {
    $status.phase = 'trimming'; Publish
    $trim = Invoke-Wsl @('--distribution', $Distro, '--user', 'root', '--exec', '/sbin/fstrim', '-av')
    $status.trim_output = $trim.Output
    $status.trim_exit = $trim.Exit
    if ($trim.Exit -ne 0) { throw "WSL fstrim failed: $($trim.Exit)" }
  }
  if ($Simulate) {
    $status.phase = 'verifying'; Publish
    $verify = Invoke-Wsl @('--distribution', $Distro, '--user', $WslUser, '--exec', '/bin/bash', $VerifyScript, $WebOrigin)
    $status.verify_output = $verify.Output
    $status.verify_exit = $verify.Exit
    if ($verify.Exit -ne 0) { throw 'smoke verification failed' }
    $status.after_free_bytes = (Get-PSDrive -Name $drive).Free
    $status.after_vhdx_bytes = (Get-Item -LiteralPath $Vhdx).Length
    $status.reclaimed_bytes = $status.after_free_bytes - $status.before_free_bytes
    $status.vhdx_reduced_bytes = $status.before_vhdx_bytes - $status.after_vhdx_bytes
    $status.phase = 'complete'; Publish
    exit 0
  }
  # Give the caller time to print the handoff result and exit WSL.
  Start-Sleep -Seconds 5
  $status.phase = 'compacting'; Publish
  $stopAttempted = $true
  $compact = Invoke-Wsl @('--manage', $Distro, '--compact')
  $status.compact_output = $compact.Output
  $status.compact_exit = $compact.Exit
  $status.after_free_bytes = (Get-PSDrive -Name $drive).Free
  $status.after_vhdx_bytes = (Get-Item -LiteralPath $Vhdx).Length
  $status.reclaimed_bytes = $status.after_free_bytes - $status.before_free_bytes
  $status.vhdx_reduced_bytes = $status.before_vhdx_bytes - $status.after_vhdx_bytes
  if ($compact.Exit -ne 0) { throw "WSL compact failed: $($compact.Exit)" }
  $status.phase = 'restarting'; Publish

  $task = Get-ScheduledTask -TaskName $KeepaliveTask -ErrorAction SilentlyContinue
  if (-not $task) { throw "Keepalive task missing: $KeepaliveTask" }
  if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $KeepaliveTask }

  $status.phase = 'verifying'; Publish
  $deadline = (Get-Date).AddMinutes(4)
  do {
    Start-Sleep -Seconds 5
    $verify = Invoke-Wsl @('--distribution', $Distro, '--user', $WslUser, '--exec', '/bin/bash', $VerifyScript, $WebOrigin)
  } until ($verify.Exit -eq 0 -or (Get-Date) -ge $deadline)
  $status.verify_output = $verify.Output
  $status.verify_exit = $verify.Exit
  if ($verify.Exit -ne 0) { throw 'WSL services or web relay did not recover within 4 minutes' }
  $status.keepalive_state = (Get-ScheduledTask -TaskName $KeepaliveTask).State.ToString()
  if ($status.keepalive_state -ne 'Running') { throw 'WSL keepalive task did not remain running' }
  $status.phase = 'complete'; Publish
} catch {
  $originalError = $_.Exception.Message
  if ($stopAttempted) {
    try {
      $task = Get-ScheduledTask -TaskName $KeepaliveTask -ErrorAction SilentlyContinue
      if ($task -and $task.State -ne 'Running') { Start-ScheduledTask -TaskName $KeepaliveTask }
      $restart = Invoke-Wsl @('--distribution', $Distro, '--user', $WslUser, '--exec', '/bin/true')
      $status.restart_attempt_exit = $restart.Exit
    } catch {
      $status.restart_error = $_.Exception.Message
    }
  }
  $status.failed_stage = $status.phase
  $status.phase = 'failed'
  $status.error = $originalError
  if ($status.before_free_bytes -ne $null) {
    try {
      $status.after_free_bytes = (Get-PSDrive -Name $drive).Free
      $status.after_vhdx_bytes = (Get-Item -LiteralPath $Vhdx).Length
      $status.reclaimed_bytes = $status.after_free_bytes - $status.before_free_bytes
      $status.vhdx_reduced_bytes = $status.before_vhdx_bytes - $status.after_vhdx_bytes
    } catch {
      $status.measure_error = $_.Exception.Message
    }
  }
  Publish
  exit 1
}
