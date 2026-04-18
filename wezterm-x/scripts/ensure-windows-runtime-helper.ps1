param(
  [int]$Port = 0,

  [string]$StatePath = "$env:LOCALAPPDATA\wezterm-runtime-helper\state.env",

  [string]$ClipboardStatePath = '',

  [string]$ClipboardLogPath = '',

  [string]$ClipboardOutputDir = '',

  [string]$ClipboardWslDistro = '',

  [int]$ClipboardHeartbeatIntervalSeconds = 1,

  [int]$ClipboardHeartbeatTimeoutSeconds = 3,

  [int]$ClipboardImageReadRetryCount = 12,

  [int]$ClipboardImageReadRetryDelayMs = 100,

  [int]$ClipboardCleanupMaxAgeHours = 48,

  [int]$ClipboardCleanupMaxFiles = 32,

  [int]$HeartbeatTimeoutSeconds = 5,

  [int]$HeartbeatIntervalMs = 1000,

  [int]$PollIntervalMs = 25,

  [string]$DiagnosticsEnabled = '0',

  [string]$DiagnosticsCategoryEnabled = '0',

  [string]$DiagnosticsLevel = 'info',

  [string]$DiagnosticsFile = '',

  [int]$DiagnosticsMaxBytes = 0,

  [int]$DiagnosticsMaxFiles = 0
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'windows-structured-log.ps1')
Initialize-StructuredLog `
  -FilePath $DiagnosticsFile `
  -Enabled $DiagnosticsEnabled `
  -CategoryEnabled $DiagnosticsCategoryEnabled `
  -Level $DiagnosticsLevel `
  -Source 'windows-helper-launcher' `
  -TraceId '' `
  -MaxBytes $DiagnosticsMaxBytes `
  -MaxFiles $DiagnosticsMaxFiles

function Get-NowEpochMilliseconds {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Ensure-ParentDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    $null = New-Item -ItemType Directory -Force -Path $parent
  }
}

function Read-HelperState {
  if ([string]::IsNullOrWhiteSpace($StatePath) -or -not (Test-Path -LiteralPath $StatePath)) {
    return $null
  }

  $state = @{}
  foreach ($line in Get-Content -LiteralPath $StatePath -ErrorAction Stop) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }

    $parts = $line.Split('=', 2)
    if (@($parts).Length -eq 2) {
      $state[$parts[0]] = $parts[1]
    }
  }

  if (@($state.Keys).Length -eq 0) {
    return $null
  }

  return $state
}

function Read-ManagerConfig {
  param(
    [hashtable]$ManagerPaths
  )

  if ($null -eq $ManagerPaths -or -not (Test-Path -LiteralPath $ManagerPaths.Config)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $ManagerPaths.Config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-ManagerConfigMatches {
  param(
    [object]$Config,
    [string]$RuntimeDir
  )

  if ($null -eq $Config) {
    return $false
  }

  if ([string]$Config.runtimeDir -ne $RuntimeDir) {
    return $false
  }

  if ([string]$Config.ipcEndpoint -ne (Get-ManagerPaths).IpcEndpoint) {
    return $false
  }

  if ([string]$Config.clipboardStatePath -ne $ClipboardStatePath) {
    return $false
  }

  if ([string]$Config.clipboardLogPath -ne $ClipboardLogPath) {
    return $false
  }

  if ([string]$Config.clipboardOutputDir -ne $ClipboardOutputDir) {
    return $false
  }

  if ([string]$Config.clipboardWslDistro -ne $ClipboardWslDistro) {
    return $false
  }

  return $true
}

function Test-HelperStateFresh {
  param(
    [hashtable]$State,
    [string]$ExpectedRuntimeDir
  )

  if ($null -eq $State) {
    return $false
  }

  if ([string]$State.ready -ne '1') {
    return $false
  }

  $helperPid = 0
  [void][int]::TryParse([string]$State.pid, [ref]$helperPid)
  if ($helperPid -le 0) {
    return $false
  }

  $heartbeatAtMs = 0
  [void][long]::TryParse([string]$State.heartbeat_at_ms, [ref]$heartbeatAtMs)
  if ($heartbeatAtMs -le 0) {
    return $false
  }

  if ((Get-NowEpochMilliseconds) - $heartbeatAtMs -gt ($HeartbeatTimeoutSeconds * 1000)) {
    return $false
  }

  if (-not [string]::IsNullOrWhiteSpace($ExpectedRuntimeDir) -and [string]$State.runtime_dir -ne $ExpectedRuntimeDir) {
    return $false
  }

  $process = Get-Process -Id $helperPid -ErrorAction SilentlyContinue
  return ($null -ne $process)
}

function Get-ExpectedRuntimeDir {
  return Split-Path -Parent $PSScriptRoot
}

function Get-ManagerPaths {
  $managerRoot = Join-Path $env:LOCALAPPDATA 'wezterm-runtime-helper'
  return @{
    Root = $managerRoot
    Exe = Join-Path $managerRoot 'bin\helper-manager.exe'
    Config = Join-Path $managerRoot 'manager-config.json'
    IpcEndpoint = '\\.\pipe\wezterm-host-helper-v1'
  }
}

function Stop-StaleProcesses {
  param([hashtable]$State)

  if ($null -ne $State) {
    $helperPid = 0
    [void][int]::TryParse([string]$State.pid, [ref]$helperPid)
    if ($helperPid -gt 0) {
      try {
        Stop-Process -Id $helperPid -Force -ErrorAction Stop
      } catch {
      }
    }
  }
}

function Write-ManagerConfig {
  param(
    [string]$RuntimeDir,
    [hashtable]$ManagerPaths
  )

  $config = [ordered]@{
    runtimeDir = $RuntimeDir
    scriptsDir = Join-Path $RuntimeDir 'scripts'
    statePath = $StatePath
    ipcEndpoint = $ManagerPaths.IpcEndpoint
    powerShellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    clipboardStatePath = $ClipboardStatePath
    clipboardLogPath = $ClipboardLogPath
    clipboardOutputDir = $ClipboardOutputDir
    clipboardWslDistro = $ClipboardWslDistro
    clipboardHeartbeatIntervalSeconds = $ClipboardHeartbeatIntervalSeconds
    clipboardImageReadRetryCount = $ClipboardImageReadRetryCount
    clipboardImageReadRetryDelayMs = $ClipboardImageReadRetryDelayMs
    clipboardCleanupMaxAgeHours = $ClipboardCleanupMaxAgeHours
    clipboardCleanupMaxFiles = $ClipboardCleanupMaxFiles
    heartbeatIntervalMs = $HeartbeatIntervalMs
    pollIntervalMs = $PollIntervalMs
    diagnostics = [ordered]@{
      enabled = ($DiagnosticsEnabled -eq '1')
      categoryEnabled = ($DiagnosticsCategoryEnabled -eq '1')
      level = $DiagnosticsLevel
      filePath = $DiagnosticsFile
      maxBytes = $DiagnosticsMaxBytes
      maxFiles = $DiagnosticsMaxFiles
    }
  }

  Ensure-ParentDirectory -Path $ManagerPaths.Config
  $json = $config | ConvertTo-Json -Depth 5
  $tempPath = "$($ManagerPaths.Config).tmp"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempPath, $json, $utf8NoBom)
  Move-Item -Force -LiteralPath $tempPath -Destination $ManagerPaths.Config
}

function Ensure-ManagerInstalled {
  param(
    [string]$RuntimeDir,
    [hashtable]$ManagerPaths
  )

  if (Test-Path -LiteralPath $ManagerPaths.Exe) {
    return
  }

  $installerScript = Join-Path $PSScriptRoot 'install-windows-runtime-helper-manager.ps1'
  if (-not (Test-Path -LiteralPath $installerScript)) {
    throw "helper manager installer missing: $installerScript"
  }

  & $installerScript -RuntimeDir $RuntimeDir | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ManagerPaths.Exe)) {
    throw 'helper manager install failed'
  }
}

try {
  $runtimeDir = Get-ExpectedRuntimeDir
  $managerPaths = Get-ManagerPaths
  $state = Read-HelperState
  $managerConfig = Read-ManagerConfig -ManagerPaths $managerPaths
  if ((Test-HelperStateFresh -State $state -ExpectedRuntimeDir $runtimeDir) -and (Test-ManagerConfigMatches -Config $managerConfig -RuntimeDir $runtimeDir)) {
    exit 0
  }

  Stop-StaleProcesses -State $state
  Ensure-ManagerInstalled -RuntimeDir $runtimeDir -ManagerPaths $managerPaths
  Write-ManagerConfig -RuntimeDir $runtimeDir -ManagerPaths $managerPaths

  $child = Start-Process -FilePath $managerPaths.Exe -ArgumentList @('--config', $managerPaths.Config) -PassThru
  Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'launcher started helper manager' -Fields @{
    child_pid = $child.Id
    runtime_dir = $runtimeDir
    state_path = $StatePath
    ipc_endpoint = $managerPaths.IpcEndpoint
  }

  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 100
    $state = Read-HelperState
    if (Test-HelperStateFresh -State $state -ExpectedRuntimeDir $runtimeDir) {
      exit 0
    }
  }

  throw 'launcher timed out waiting for helper manager heartbeat'
} catch {
  Write-StructuredLog -Level 'error' -Category 'alt_o' -Message 'launcher failed to ensure helper manager' -Fields @{
    state_path = $StatePath
    ipc_endpoint = $managerPaths.IpcEndpoint
    error = $_.Exception.Message
  }
  throw
}
