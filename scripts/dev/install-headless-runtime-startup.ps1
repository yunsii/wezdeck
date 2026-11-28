#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)]
  [string]$Distro,
  [string]$TaskName = 'WezDeck Runtime'
)

$ErrorActionPreference = 'Stop'
$ensure = Join-Path $env:USERPROFILE '.wezterm-x\scripts\ensure-wezdeck-runtime.ps1'
if (-not (Test-Path -LiteralPath $ensure -PathType Leaf)) {
  throw "Runtime ensure script missing: $ensure. Run sync-runtime.sh first."
}

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$encodedPath = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(
  "& (Get-Item -LiteralPath '$($ensure.Replace("'", "''"))').FullName"
))
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encodedPath"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start the WezDeck Runtime for the local web console without opening WezTerm.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$wslTaskName = 'WezDeck WSL Keepalive'
if (-not (Get-ScheduledTask -TaskName $wslTaskName -ErrorAction SilentlyContinue)) {
  $wslCommand = '$p = Start-Process -FilePath wsl.exe -ArgumentList ''--distribution ' +
    $Distro.Replace("'", "''") +
    ' --exec /bin/sleep infinity'' -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode'
  $encodedWslCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wslCommand))
  $wslAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encodedWslCommand"
  $wslSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $wslTaskName -Action $wslAction -Trigger $trigger -Principal $principal -Settings $wslSettings -Description 'Keep the WezDeck WSL distribution running without a WezTerm window.' | Out-Null
}
if ((Get-ScheduledTask -TaskName $wslTaskName).State -ne 'Running') {
  Start-ScheduledTask -TaskName $wslTaskName
}
Write-Output "$TaskName and $wslTaskName ready for $user"
