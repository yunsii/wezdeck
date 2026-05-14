param(
  [string]$StatePath = "$env:LOCALAPPDATA\wezterm-runtime\state\helper\state.env",

  [string]$ClipboardOutputDir = '',

  [string]$ClipboardWslDistro = '',

  [int]$ClipboardImageReadRetryCount = 12,

  [int]$ClipboardImageReadRetryDelayMs = 100,

  [int]$ClipboardCleanupMaxAgeHours = 48,

  [int]$ClipboardCleanupMaxFiles = 32,

  [int]$HeartbeatTimeoutSeconds = 5,

  [int]$HeartbeatIntervalMs = 1000,

  [string]$DiagnosticsEnabled = '0',

  [string]$DiagnosticsCategoryEnabled = '0',

  [string]$DiagnosticsLevel = 'info',

  [string]$DiagnosticsFile = '',

  [int]$DiagnosticsMaxBytes = 0,

  [int]$DiagnosticsMaxFiles = 0,

  [string]$ChromeDebugAutoStartEnabled = '0',

  [string]$ChromeDebugChromePath = '',

  [int]$ChromeDebugRemoteDebuggingPort = 9222,

  [string]$ChromeDebugUserDataDir = ''
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

function Test-HelperStateFresh {
  param(
    [hashtable]$State,
    [string]$ExpectedRuntimeDir,
    [string]$ExpectedConfigHash
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

  if (-not [string]::IsNullOrWhiteSpace($ExpectedConfigHash) -and [string]$State.config_hash -ne $ExpectedConfigHash) {
    return $false
  }

  $process = Get-Process -Id $helperPid -ErrorAction SilentlyContinue
  return ($null -ne $process)
}

function Get-ExpectedRuntimeDir {
  return Split-Path -Parent $PSScriptRoot
}

function Get-ManagerPaths {
  $managerRoot = Join-Path $env:LOCALAPPDATA 'wezterm-runtime'
  return @{
    Root = $managerRoot
    Exe = Join-Path $managerRoot 'bin\helper-manager.exe'
    Config = Join-Path $managerRoot 'state\helper\manager-config.json'
    WindowCache = Join-Path $managerRoot 'cache\helper\window-cache.json'
    IpcEndpoint = '\\.\pipe\wezterm-host-helper-v1'
  }
}

function Stop-StaleProcesses {
  param([hashtable]$State)

  foreach ($process in @(Get-Process -Name 'helper-manager' -ErrorAction SilentlyContinue)) {
    try {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
    } catch {
    } finally {
      $process.Dispose()
    }
  }

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

  # Inherit chrome-debug config from the previously-written manager-config.json
  # when none of the ChromeDebug* parameters were explicitly bound. Two callers
  # exercise this script today and only one of them (wezterm Lua, via
  # build_helper_command) passes chrome args; the sync-runtime path
  # (sync-helper-windows-lib.sh::ensure_windows_helper_running) does not, and
  # without inheritance a sync-driven helper restart would silently flip
  # chromeDebugAutoStart.enabled to false and leave the CDP badge stuck at "-"
  # until wezterm reloaded.
  $chromeArgsBound = $PSBoundParameters.ContainsKey('ChromeDebugAutoStartEnabled') `
    -or $PSBoundParameters.ContainsKey('ChromeDebugChromePath') `
    -or $PSBoundParameters.ContainsKey('ChromeDebugUserDataDir') `
    -or $PSBoundParameters.ContainsKey('ChromeDebugRemoteDebuggingPort')
  $chromeAutoStartEnabled = ($ChromeDebugAutoStartEnabled -eq '1')
  $chromeChromePath = $ChromeDebugChromePath
  $chromeRemotePort = $ChromeDebugRemoteDebuggingPort
  $chromeUserDataDir = $ChromeDebugUserDataDir
  if (-not $chromeArgsBound -and (Test-Path -LiteralPath $ManagerPaths.Config)) {
    try {
      $previous = Get-Content -LiteralPath $ManagerPaths.Config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($previous -and $previous.chromeDebugAutoStart) {
        $chromeAutoStartEnabled = [bool]$previous.chromeDebugAutoStart.enabled
        $chromeChromePath = [string]$previous.chromeDebugAutoStart.chromePath
        $chromeRemotePort = [int]$previous.chromeDebugAutoStart.remoteDebuggingPort
        $chromeUserDataDir = [string]$previous.chromeDebugAutoStart.userDataDir
      }
    } catch {
      # Fall back to the unbound defaults; this matches the prior behavior
      # for the very first ensure when no manager-config.json exists yet.
    }
  }

  $config = [ordered]@{
    runtimeDir = $RuntimeDir
    statePath = $StatePath
    windowCachePath = $ManagerPaths.WindowCache
    ipcEndpoint = $ManagerPaths.IpcEndpoint
    chromeDebugStatePath = Join-Path $env:LOCALAPPDATA 'wezterm-runtime\state\chrome-debug\state.json'
    chromeDebugAutoStart = [ordered]@{
      enabled = $chromeAutoStartEnabled
      chromePath = $chromeChromePath
      remoteDebuggingPort = $chromeRemotePort
      userDataDir = $chromeUserDataDir
    }
    clipboardOutputDir = $ClipboardOutputDir
    clipboardWslDistro = $ClipboardWslDistro
    clipboardImageReadRetryCount = $ClipboardImageReadRetryCount
    clipboardImageReadRetryDelayMs = $ClipboardImageReadRetryDelayMs
    clipboardCleanupMaxAgeHours = $ClipboardCleanupMaxAgeHours
    clipboardCleanupMaxFiles = $ClipboardCleanupMaxFiles
    heartbeatIntervalMs = $HeartbeatIntervalMs
    diagnostics = [ordered]@{
      enabled = ($DiagnosticsEnabled -eq '1')
      categoryEnabled = ($DiagnosticsCategoryEnabled -eq '1')
      level = $DiagnosticsLevel
      filePath = $DiagnosticsFile
      maxBytes = $DiagnosticsMaxBytes
      maxFiles = $DiagnosticsMaxFiles
    }
  }

  $json = $config | ConvertTo-Json -Depth 5
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $jsonBytes = $utf8NoBom.GetBytes($json)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $configHash = ([System.BitConverter]::ToString($sha256.ComputeHash($jsonBytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }

  $config.configHash = $configHash
  $json = $config | ConvertTo-Json -Depth 5
  Ensure-ParentDirectory -Path $ManagerPaths.Config
  $tempPath = "$($ManagerPaths.Config).tmp"
  [System.IO.File]::WriteAllText($tempPath, $json, $utf8NoBom)
  Move-Item -Force -LiteralPath $tempPath -Destination $ManagerPaths.Config
  return $configHash
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
  $configHash = Write-ManagerConfig -RuntimeDir $runtimeDir -ManagerPaths $managerPaths
  $state = Read-HelperState
  if (Test-HelperStateFresh -State $state -ExpectedRuntimeDir $runtimeDir -ExpectedConfigHash $configHash) {
    exit 0
  }

  Stop-StaleProcesses -State $state
  Ensure-ManagerInstalled -RuntimeDir $runtimeDir -ManagerPaths $managerPaths

  $child = Start-Process -FilePath $managerPaths.Exe -ArgumentList @('--config', $managerPaths.Config) -PassThru
  Write-StructuredLog -Level 'info' -Category 'host_helper' -Message 'launcher started helper manager' -Fields @{
    child_pid = $child.Id
    runtime_dir = $runtimeDir
    state_path = $StatePath
    ipc_endpoint = $managerPaths.IpcEndpoint
  }

  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 100
    $state = Read-HelperState
    if (Test-HelperStateFresh -State $state -ExpectedRuntimeDir $runtimeDir -ExpectedConfigHash $configHash) {
      exit 0
    }
  }

  throw 'launcher timed out waiting for helper manager heartbeat'
} catch {
  Write-StructuredLog -Level 'error' -Category 'host_helper' -Message 'launcher failed to ensure helper manager' -Fields @{
    state_path = $StatePath
    ipc_endpoint = $managerPaths.IpcEndpoint
    error = $_.Exception.Message
  }
  throw
}
