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

  [int]$HttpPort = 35791,

  [string]$HttpAllowedOrigins = 'https://*.vercel.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001',

  [string]$DiagnosticsEnabled = '0',

  [string]$DiagnosticsCategoryEnabled = '0',

  [string]$DiagnosticsLevel = 'info',

  [string]$DiagnosticsFile = '',

  [int]$DiagnosticsMaxBytes = 0,

  [int]$DiagnosticsMaxFiles = 0,

  [string]$ChromeDebugAutoStartEnabled = '0',

  [string]$ChromeDebugChromePath = '',

  [int]$ChromeDebugRemoteDebuggingPort = 9222,

  [string]$ChromeDebugUserDataDir = '',

  # Workflow foreground sampling (WezDeck Runtime → helper.log category=foreground).
  # Mode: allowlist (personal default) | all (work device) | off
  [string]$ForegroundSamplingMode = 'allowlist',

  # Comma-separated Process.ProcessName values (no .exe). Empty → built-in
  # WezTerm + VS Code + Chrome defaults inside the helper.
  [string]$ForegroundAllowlist = ''
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

  # A helper killed seconds ago (e.g. by the installer swapping the binary)
  # leaves a state.env whose heartbeat still looks fresh. Trust it only while
  # the recorded pid is a live wezdeck-runtime process.
  $helperProcess = Get-Process -Id $helperPid -ErrorAction SilentlyContinue
  if ($null -eq $helperProcess -or $helperProcess.ProcessName -ne 'wezdeck-runtime') {
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
  # Instance root = <root>\state\helper\state.env, three levels up. The live
  # instance is %LOCALAPPDATA%\wezterm-runtime; anything else (the sync canary
  # runs with WEZTERM_RUNTIME_STATE_DIR=…\wezterm-runtime\canary) gets its own
  # config, pipe, HTTP port and state files so it can coexist with live. The
  # Lua side mirrors the endpoint rule in
  # defaults.default_windows_runtime_helper_ipc_endpoint.
  $liveRoot = Join-Path $env:LOCALAPPDATA 'wezterm-runtime'
  $instanceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $StatePath))
  $isLive = [string]::IsNullOrWhiteSpace($instanceRoot) -or
    [string]::Equals($instanceRoot.TrimEnd('\'), $liveRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
  if ($isLive) {
    $instanceRoot = $liveRoot
    $ipcEndpoint = '\\.\pipe\wezdeck-runtime-v1'
    $httpPort = $HttpPort
  } else {
    $suffix = ((Split-Path -Leaf $instanceRoot).ToLowerInvariant() -replace '[^a-z0-9-]', '_')
    $ipcEndpoint = '\\.\pipe\wezdeck-runtime-v1-' + $suffix
    $httpPort = $HttpPort + 1
  }
  return @{
    Root = $instanceRoot
    IsLive = $isLive
    # One shared binary; only config / pipe / state are per instance.
    Exe = Join-Path $liveRoot 'bin\wezdeck-runtime.exe'
    Config = Join-Path $instanceRoot 'state\helper\manager-config.json'
    WindowCache = Join-Path $instanceRoot 'cache\helper\window-cache.json'
    IpcEndpoint = $ipcEndpoint
    HttpPort = $httpPort
  }
}

function Stop-StaleProcesses {
  param([hashtable]$ManagerPaths)

  # Only this instance's helpers: every helper is started with
  # `--config <instance>\state\helper\manager-config.json`, so the command line
  # tells live and canary apart. Killing every wezdeck-runtime here used to let
  # the sync canary evict the live helper (2026-11-21).
  $configPath = [string]$ManagerPaths.Config
  $targets = @(Get-CimInstance Win32_Process -Filter "Name = 'wezdeck-runtime.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $cmd = [string]$_.CommandLine
    (-not [string]::IsNullOrWhiteSpace($cmd)) -and
      $cmd.IndexOf($configPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  foreach ($process in $targets) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
    }
  }
}

function Write-ManagerConfig {
  param(
    [string]$RuntimeDir,
    [hashtable]$ManagerPaths,
    [bool]$ChromeArgsBound = $false,
    [bool]$FgArgsBound = $false
  )

  # Inherit chrome-debug / foregroundSampling from the previously-written
  # manager-config.json when the matching script-level params were not bound.
  # Bound flags MUST be computed at script scope ($PSBoundParameters there) and
  # passed in — inside this function $PSBoundParameters only sees RuntimeDir /
  # ManagerPaths / these two bools.
  # Sync-runtime often omits chrome args; without inheritance a sync-driven
  # helper restart would flip chromeDebugAutoStart.enabled to false.
  $chromeAutoStartEnabled = ($ChromeDebugAutoStartEnabled -eq '1')
  $chromeChromePath = $ChromeDebugChromePath
  $chromeRemotePort = $ChromeDebugRemoteDebuggingPort
  $chromeUserDataDir = $ChromeDebugUserDataDir
  $fgMode = $ForegroundSamplingMode
  $fgAllowlistRaw = $ForegroundAllowlist
  if (-not $ChromeArgsBound -or -not $FgArgsBound) {
    if (Test-Path -LiteralPath $ManagerPaths.Config) {
      try {
        $previous = Get-Content -LiteralPath $ManagerPaths.Config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if (-not $ChromeArgsBound -and $previous -and $previous.chromeDebugAutoStart) {
          $chromeAutoStartEnabled = [bool]$previous.chromeDebugAutoStart.enabled
          $chromeChromePath = [string]$previous.chromeDebugAutoStart.chromePath
          $chromeRemotePort = [int]$previous.chromeDebugAutoStart.remoteDebuggingPort
          $chromeUserDataDir = [string]$previous.chromeDebugAutoStart.userDataDir
        }
        if (-not $FgArgsBound -and $previous -and $previous.foregroundSampling) {
          if ($previous.foregroundSampling.mode) {
            $fgMode = [string]$previous.foregroundSampling.mode
          }
          if ($previous.foregroundSampling.allowlist) {
            $fgAllowlistRaw = (@($previous.foregroundSampling.allowlist) -join ',')
          }
        }
      } catch {
        # Fall back to the unbound defaults; this matches the prior behavior
        # for the very first ensure when no manager-config.json exists yet.
      }
    }
  }

  $fgAllowlist = @()
  if (-not [string]::IsNullOrWhiteSpace($fgAllowlistRaw)) {
    $fgAllowlist = @(
      $fgAllowlistRaw.Split(',') |
        ForEach-Object { $_.Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
  }
  if ([string]::IsNullOrWhiteSpace($fgMode)) {
    $fgMode = 'allowlist'
  }

  $config = [ordered]@{
    runtimeDir = $RuntimeDir
    statePath = $StatePath
    windowCachePath = $ManagerPaths.WindowCache
    ipcEndpoint = $ManagerPaths.IpcEndpoint
    httpPort = $ManagerPaths.HttpPort
    httpAllowedOrigins = @(
      $HttpAllowedOrigins.Split(',') |
        ForEach-Object { $_.Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    chromeDebugStatePath = Join-Path $ManagerPaths.Root 'state\chrome-debug\state.json'
    chromeDebugAutoStart = [ordered]@{
      # A non-live instance (sync canary) must not start / adopt Chrome.
      enabled = ($chromeAutoStartEnabled -and $ManagerPaths.IsLive)
      chromePath = $chromeChromePath
      remoteDebuggingPort = $chromeRemotePort
      userDataDir = $chromeUserDataDir
    }
    # Ego right-status badge heartbeat (EgoHeartbeatSampler). Only refreshes
    # when status.json already has backend=ego; apply-browser-backend owns the
    # backend switch. Path mirrors Lua browser_agent.status_file default.
    browserAgentStatusPath = Join-Path $ManagerPaths.Root 'state\browser-agent\status.json'
    clipboardOutputDir = $ClipboardOutputDir
    clipboardWslDistro = $ClipboardWslDistro
    clipboardImageReadRetryCount = $ClipboardImageReadRetryCount
    clipboardImageReadRetryDelayMs = $ClipboardImageReadRetryDelayMs
    clipboardCleanupMaxAgeHours = $ClipboardCleanupMaxAgeHours
    clipboardCleanupMaxFiles = $ClipboardCleanupMaxFiles
    heartbeatIntervalMs = $HeartbeatIntervalMs
    foregroundSampling = [ordered]@{
      mode = $fgMode
      allowlist = @($fgAllowlist)
    }
    # WSL package-upgrade heal: relaunch WezTerm only when Windows Update/MSI
    # evidence says the outage was an upgrade, not a user stop. Audit trail:
    # state/wsl-heal/status.json + history.ndjson. Docs:
    # docs/development-environment-troubleshooting.md#wsl-upgrade-heal
    wslHeal = [ordered]@{
      # Only the live helper may relaunch WezTerm / reconnect VS Code.
      enabled = $ManagerPaths.IsLive
      statusPath = Join-Path $ManagerPaths.Root 'state\wsl-heal\status.json'
      historyPath = Join-Path $ManagerPaths.Root 'state\wsl-heal\history.ndjson'
      suppressUntilPath = Join-Path $ManagerPaths.Root 'state\wsl-heal\suppress-until'
      relaunchWezTerm = $true
      reconnectVscode = $true
      vscodeMaxWindows = 5
      vscodeCommand = 'code'
      probeIntervalMs = 15000
      updateEvidenceWindowMs = 600000
      cooldownMs = 600000
      historyMaxLines = 500
    }
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

  $installerScript = Join-Path $PSScriptRoot 'install-wezdeck-runtime.ps1'
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
  $chromeArgsBound = $PSBoundParameters.ContainsKey('ChromeDebugAutoStartEnabled') `
    -or $PSBoundParameters.ContainsKey('ChromeDebugChromePath') `
    -or $PSBoundParameters.ContainsKey('ChromeDebugUserDataDir') `
    -or $PSBoundParameters.ContainsKey('ChromeDebugRemoteDebuggingPort')
  $fgArgsBound = $PSBoundParameters.ContainsKey('ForegroundSamplingMode') `
    -or $PSBoundParameters.ContainsKey('ForegroundAllowlist')
  $configHash = Write-ManagerConfig `
    -RuntimeDir $runtimeDir `
    -ManagerPaths $managerPaths `
    -ChromeArgsBound:$chromeArgsBound `
    -FgArgsBound:$fgArgsBound
  $state = Read-HelperState
  if (Test-HelperStateFresh -State $state -ExpectedRuntimeDir $runtimeDir -ExpectedConfigHash $configHash) {
    exit 0
  }

  Stop-StaleProcesses -ManagerPaths $managerPaths
  Ensure-ManagerInstalled -RuntimeDir $runtimeDir -ManagerPaths $managerPaths

  $child = Start-Process -FilePath $managerPaths.Exe -ArgumentList @('--config', $managerPaths.Config) -PassThru
  Write-StructuredLog -Level 'info' -Category 'wezdeck_runtime' -Message 'launcher started helper manager' -Fields @{
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
  Write-StructuredLog -Level 'error' -Category 'wezdeck_runtime' -Message 'launcher failed to ensure helper manager' -Fields @{
    state_path = $StatePath
    ipc_endpoint = $managerPaths.IpcEndpoint
    error = $_.Exception.Message
  }
  throw
}
