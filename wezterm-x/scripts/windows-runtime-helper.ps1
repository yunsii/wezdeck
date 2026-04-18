param(
  [int]$Port = 0,

  [string]$StatePath = "$env:LOCALAPPDATA\wezterm-runtime-helper\state.env",

  [string]$RequestDir = "$env:LOCALAPPDATA\wezterm-runtime-helper\requests",

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

. (Join-Path (Split-Path -Parent $PSCommandPath) 'windows-structured-log.ps1')

function Set-HelperLogger {
  Initialize-StructuredLog `
    -FilePath $DiagnosticsFile `
    -Enabled $DiagnosticsEnabled `
    -CategoryEnabled $DiagnosticsCategoryEnabled `
    -Level $DiagnosticsLevel `
    -Source 'windows-helper' `
    -TraceId '' `
    -MaxBytes $DiagnosticsMaxBytes `
    -MaxFiles $DiagnosticsMaxFiles
}

function Set-RequestLogger {
  param(
    [string]$TraceId
  )

  Initialize-StructuredLog `
    -FilePath $DiagnosticsFile `
    -Enabled $DiagnosticsEnabled `
    -CategoryEnabled $DiagnosticsCategoryEnabled `
    -Level $DiagnosticsLevel `
    -Source 'windows-alt-o' `
    -TraceId $TraceId `
    -MaxBytes $DiagnosticsMaxBytes `
    -MaxFiles $DiagnosticsMaxFiles
}

function Get-NowEpochMilliseconds {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Ensure-Directory {
  param(
    [string]$Path
  )

  if (-not [string]::IsNullOrWhiteSpace($Path)) {
    $null = New-Item -ItemType Directory -Force -Path $Path
  }
}

function Write-HelperState {
  param(
    [string]$Ready = '1',
    [string]$LastError = ''
  )

  $stateDir = Split-Path -Parent $StatePath
  Ensure-Directory -Path $stateDir

  $lines = @(
    'version=2',
    "ready=$Ready",
    "pid=$PID",
    "started_at_ms=$script:StartedAtMs",
    "heartbeat_at_ms=$(Get-NowEpochMilliseconds)",
    "request_dir=$RequestDir",
    "last_error=$LastError"
  )

  $tempPath = "$StatePath.tmp"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempPath, ($lines -join "`r`n") + "`r`n", $utf8NoBom)
  Move-Item -Force -LiteralPath $tempPath -Destination $StatePath
}

function Remove-RequestFile {
  param(
    [string]$Path
  )

  if (-not [string]::IsNullOrWhiteSpace($Path) -and (Test-Path -LiteralPath $Path)) {
    Remove-Item -Force -LiteralPath $Path -ErrorAction SilentlyContinue
  }
}

function Process-PendingRequests {
  $requestFiles = @(Get-ChildItem -LiteralPath $RequestDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)
  foreach ($requestFile in $requestFiles) {
    try {
      $requestText = [System.IO.File]::ReadAllText($requestFile.FullName, [System.Text.Encoding]::UTF8)
      if ([string]::IsNullOrWhiteSpace($requestText)) {
        Remove-RequestFile -Path $requestFile.FullName
        continue
      }

      $payload = ConvertFrom-Json -InputObject $requestText
      $requestId = if ($null -ne $payload -and $payload.request_id) { [string]$payload.request_id } else { $requestFile.BaseName }
      $result = Invoke-AltORequest -Payload $payload
      Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'helper processed request' -Fields @{
        request_id = $requestId
        request_path = $requestFile.FullName
        status = if ($null -ne $result -and $result.status) { [string]$result.status } else { 'unknown' }
      }
      Remove-RequestFile -Path $requestFile.FullName
    } catch {
      Write-HelperState -Ready '1' -LastError $_.Exception.Message
      Write-StructuredLog -Level 'error' -Category 'alt_o' -Message 'helper request failed' -Fields @{
        request_path = $requestFile.FullName
        error = $_.Exception.Message
      }
      Remove-RequestFile -Path $requestFile.FullName
      Set-HelperLogger
    }
  }
}

function Invoke-AltORequest {
  param(
    [object]$Payload
  )

  $traceId = ''
  if ($null -ne $Payload -and $Payload.trace_id) {
    $traceId = [string]$Payload.trace_id
  }

  Set-RequestLogger -TraceId $traceId

  $codeArgs = @()
  foreach ($item in @($Payload.code_command)) {
    $codeArgs += [string]$item
  }

  $scriptPath = Join-Path (Split-Path -Parent $PSCommandPath) 'focus-or-open-vscode.ps1'
  $result = & $scriptPath `
    -RequestedDir ([string]$Payload.requested_dir) `
    -Distro ([string]$Payload.distro) `
    -CodeArg $codeArgs `
    -TraceId $traceId `
    -DiagnosticsEnabled $DiagnosticsEnabled `
    -DiagnosticsCategoryEnabled $DiagnosticsCategoryEnabled `
    -DiagnosticsLevel $DiagnosticsLevel `
    -DiagnosticsFile $DiagnosticsFile `
    -DiagnosticsMaxBytes $DiagnosticsMaxBytes `
    -DiagnosticsMaxFiles $DiagnosticsMaxFiles `
    -ReturnResult

  Set-HelperLogger
  return $result
}

$script:StartedAtMs = Get-NowEpochMilliseconds
Set-HelperLogger

$watcher = $null
$eventIds = @()
try {
  Ensure-Directory -Path (Split-Path -Parent $StatePath)
  Ensure-Directory -Path $RequestDir

  $watcher = New-Object System.IO.FileSystemWatcher
  $watcher.Path = $RequestDir
  $watcher.Filter = '*.json'
  $watcher.IncludeSubdirectories = $false
  $watcher.NotifyFilter = [System.IO.NotifyFilters]'FileName, LastWrite, CreationTime'
  $watcher.EnableRaisingEvents = $true
  $eventIds = @(
    'wezterm-helper-request-created',
    'wezterm-helper-request-changed',
    'wezterm-helper-request-renamed'
  )
  Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier $eventIds[0] | Out-Null
  Register-ObjectEvent -InputObject $watcher -EventName Changed -SourceIdentifier $eventIds[1] | Out-Null
  Register-ObjectEvent -InputObject $watcher -EventName Renamed -SourceIdentifier $eventIds[2] | Out-Null

  Write-HelperState -Ready '1'
  Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'helper started' -Fields @{
    state_path = $StatePath
    request_dir = $RequestDir
    pid = $PID
  }
  Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'helper request directory watcher active' -Fields @{
    request_dir = $RequestDir
  }

  $lastHeartbeatMs = Get-NowEpochMilliseconds
  Process-PendingRequests
  while ($true) {
    $nowMs = Get-NowEpochMilliseconds
    if ($nowMs - $lastHeartbeatMs -ge $HeartbeatIntervalMs) {
      Write-HelperState -Ready '1'
      $lastHeartbeatMs = $nowMs
    }

    $timeoutSeconds = [Math]::Max([Math]::Ceiling(($HeartbeatIntervalMs - ([Math]::Max(0, ($nowMs - $lastHeartbeatMs)))) / 1000.0), 1)
    $event = Wait-Event -Timeout $timeoutSeconds
    if ($null -ne $event) {
      Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue
      Process-PendingRequests
      continue
    }

    Process-PendingRequests
  }
} catch {
  Write-HelperState -Ready '0' -LastError $_.Exception.Message
  Write-StructuredLog -Level 'error' -Category 'alt_o' -Message 'helper failed' -Fields @{
    state_path = $StatePath
    request_dir = $RequestDir
    error = $_.Exception.Message
  }
  throw
} finally {
  foreach ($eventId in $eventIds) {
    Unregister-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue
  }

  Get-EventSubscriber | Where-Object { $_.SourceObject -eq $watcher } | Unregister-Event -ErrorAction SilentlyContinue

  if ($watcher) {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
  }
}
