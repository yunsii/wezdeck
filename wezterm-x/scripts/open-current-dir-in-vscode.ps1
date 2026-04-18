param(
  [Parameter(Mandatory = $true)]
  [string]$RequestedDir,

  [Parameter(Mandatory = $true)]
  [string]$Distro,

  [string[]]$CodeArg = @(),

  [string]$CachePath = '',

  [string]$TraceId = '',

  [string]$DiagnosticsEnabled = '0',

  [string]$DiagnosticsCategoryEnabled = '0',

  [string]$DiagnosticsLevel = 'info',

  [string]$DiagnosticsFile = '',

  [int]$DiagnosticsMaxBytes = 0,

  [int]$DiagnosticsMaxFiles = 0,

  [switch]$ReturnResult
)

if (-not ([System.Management.Automation.PSTypeName]'VscodeWindow').Type) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class VscodeWindow {
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetActiveWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetFocus(IntPtr hWnd);
}
"@
}

. (Join-Path (Split-Path -Parent $PSCommandPath) 'windows-structured-log.ps1')
Initialize-StructuredLog `
  -FilePath $DiagnosticsFile `
  -Enabled $DiagnosticsEnabled `
  -CategoryEnabled $DiagnosticsCategoryEnabled `
  -Level $DiagnosticsLevel `
  -Source 'windows-alt-o' `
  -TraceId $TraceId `
  -MaxBytes $DiagnosticsMaxBytes `
  -MaxFiles $DiagnosticsMaxFiles

$script:AltOStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:WscriptShell = $null

function Get-WscriptShell {
  if ($null -eq $script:WscriptShell) {
    $script:WscriptShell = New-Object -ComObject WScript.Shell
  }

  return $script:WscriptShell
}

function Normalize-WslPath {
  param(
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return ""
  }

  $normalized = ($Path -replace '\\', '/').Trim()
  if ([string]::IsNullOrWhiteSpace($normalized)) {
    return ""
  }

  if ($normalized.Length -gt 1) {
    $normalized = $normalized.TrimEnd('/')
  }

  if ([string]::IsNullOrWhiteSpace($normalized)) {
    return "/"
  }

  return $normalized
}

function Get-DefaultCachePath {
  if (-not [string]::IsNullOrWhiteSpace($CachePath)) {
    return $CachePath
  }

  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    return (Join-Path $env:LOCALAPPDATA 'wezterm-vscode-cache\state.clixml')
  }

  return (Join-Path $env:TEMP 'wezterm-vscode-cache-state.clixml')
}

function New-CacheState {
  return @{
    Version = 1
    RepoRoots = @{}
    Windows = @{}
  }
}

function Convert-ToPlainHashtable {
  param(
    $Value
  )

  if ($null -eq $Value) {
    return $null
  }

  if ($Value -is [string] -or $Value -is [ValueType]) {
    return $Value
  }

  if ($Value -is [System.Collections.IDictionary]) {
    $result = @{}
    foreach ($key in $Value.Keys) {
      $result[[string]$key] = Convert-ToPlainHashtable -Value $Value[$key]
    }
    return $result
  }

  $properties = @($Value.PSObject.Properties)
  if ($properties.Count -gt 0) {
    $result = @{}
    foreach ($property in $properties) {
      if ($property.MemberType -notin @('NoteProperty', 'Property')) {
        continue
      }

      $result[[string]$property.Name] = Convert-ToPlainHashtable -Value $property.Value
    }

    if ($result.Count -gt 0) {
      return $result
    }
  }

  return $Value
}

function Read-CacheState {
  param(
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    return (New-CacheState)
  }

  try {
    $state = Import-Clixml -LiteralPath $Path
  } catch {
    Write-StructuredLog -Level 'warn' -Category 'alt_o' -Message 'cache import failed' -Fields @{
      cache_path = $Path
      error = $_.Exception.Message
    }
    return (New-CacheState)
  }

  if ($null -eq $state) {
    return (New-CacheState)
  }

  $state = Convert-ToPlainHashtable -Value $state

  if ($null -eq $state.RepoRoots) {
    $state.RepoRoots = @{}
  }

  if ($null -eq $state.Windows) {
    $state.Windows = @{}
  }

  return $state
}

function Write-CacheState {
  param(
    [hashtable]$State,
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $tempPath = "$Path.tmp"
  try {
    $State | Export-Clixml -LiteralPath $tempPath
    Move-Item -Force -LiteralPath $tempPath -Destination $Path
  } catch {
    Write-StructuredLog -Level 'warn' -Category 'alt_o' -Message 'cache write failed' -Fields @{
      cache_path = $Path
      error = $_.Exception.Message
    }
  }
}

function Get-CacheKey {
  param(
    [string]$Distribution,
    [string]$Path
  )

  return '{0}|{1}' -f $Distribution, (Normalize-WslPath -Path $Path)
}

function Get-RepoRootFromCache {
  param(
    [hashtable]$State,
    [string]$Key
  )

  if ($State.RepoRoots.ContainsKey($Key)) {
    $cachedRoot = Normalize-WslPath -Path ([string]$State.RepoRoots[$Key])
    if (-not [string]::IsNullOrWhiteSpace($cachedRoot) -and $cachedRoot.StartsWith('/')) {
      return $cachedRoot
    }

    $State.RepoRoots.Remove($Key)
  }

  return $null
}

function Set-RepoRootCacheEntry {
  param(
    [hashtable]$State,
    [string]$Key,
    [string]$Value
  )

  $State.RepoRoots[$Key] = (Normalize-WslPath -Path $Value)
}

function Get-WindowCacheEntry {
  param(
    [hashtable]$State,
    [string]$Key
  )

  if ($State.Windows.ContainsKey($Key)) {
    return $State.Windows[$Key]
  }

  return $null
}

function Set-WindowCacheEntry {
  param(
    [hashtable]$State,
    [string]$Key,
    [uint32]$ProcessId,
    [IntPtr]$WindowHandle
  )

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  $processStartTime = ''
  if ($null -ne $process) {
    try {
      $processStartTime = $process.StartTime.ToUniversalTime().ToString('o')
    } catch {
      $processStartTime = ''
    }
  }

  $State.Windows[$Key] = @{
    Pid = [int]$ProcessId
    Hwnd = [string]$WindowHandle.ToInt64()
    ProcessStartTime = $processStartTime
    UpdatedAt = (Get-Date).ToString('o')
  }
}

function Remove-WindowCacheEntry {
  param(
    [hashtable]$State,
    [string]$Key
  )

  if ($State.Windows.ContainsKey($Key)) {
    $State.Windows.Remove($Key)
  }
}

function Get-WslParentPath {
  param(
    [string]$Path
  )

  $normalized = Normalize-WslPath -Path $Path
  if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized -eq "/") {
    return $null
  }

  $lastSlash = $normalized.LastIndexOf('/')
  if ($lastSlash -le 0) {
    return "/"
  }

  return $normalized.Substring(0, $lastSlash)
}

function Convert-ToWslUncPath {
  param(
    [string]$Path,
    [string]$Distribution
  )

  $normalized = Normalize-WslPath -Path $Path
  if ([string]::IsNullOrWhiteSpace($normalized) -or -not $normalized.StartsWith('/')) {
    return $null
  }

  $uncRoot = '\\wsl$\{0}' -f $Distribution
  $relative = $normalized.TrimStart('/') -replace '/', '\'
  if ([string]::IsNullOrWhiteSpace($relative)) {
    return "$uncRoot\"
  }

  return '{0}\{1}' -f $uncRoot, $relative
}

function Resolve-WorktreeRootFromUnc {
  param(
    [string]$Directory,
    [string]$Distribution
  )

  $currentPath = Normalize-WslPath -Path $Directory
  if ([string]::IsNullOrWhiteSpace($currentPath) -or -not $currentPath.StartsWith('/')) {
    return $null
  }

  while ($true) {
    $uncPath = Convert-ToWslUncPath -Path $currentPath -Distribution $Distribution
    if (-not [string]::IsNullOrWhiteSpace($uncPath)) {
      $dotGitPath = Join-Path $uncPath '.git'
      if (Test-Path -LiteralPath $dotGitPath) {
        return $currentPath
      }
    }

    if ($currentPath -eq "/") {
      break
    }

    $currentPath = Get-WslParentPath -Path $currentPath
    if ([string]::IsNullOrWhiteSpace($currentPath)) {
      break
    }
  }

  return $null
}

function Resolve-WorktreeRoot {
  param(
    [string]$Directory,
    [string]$Distribution,
    [hashtable]$State
  )

  $normalizedDirectory = Normalize-WslPath -Path $Directory
  if ([string]::IsNullOrWhiteSpace($normalizedDirectory)) {
    return $Directory
  }

  $cacheKey = Get-CacheKey -Distribution $Distribution -Path $normalizedDirectory
  $cachedRoot = Get-RepoRootFromCache -State $State -Key $cacheKey
  if (-not [string]::IsNullOrWhiteSpace($cachedRoot)) {
    return $cachedRoot
  }

  $fastPathRoot = Resolve-WorktreeRootFromUnc -Directory $normalizedDirectory -Distribution $Distribution
  if (-not [string]::IsNullOrWhiteSpace($fastPathRoot)) {
    Set-RepoRootCacheEntry -State $State -Key $cacheKey -Value $fastPathRoot
    return $fastPathRoot
  }

  try {
    $repoRoot = & wsl.exe --distribution $Distribution --cd $normalizedDirectory git rev-parse --path-format=absolute --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0) {
      Set-RepoRootCacheEntry -State $State -Key $cacheKey -Value $normalizedDirectory
      return $normalizedDirectory
    }

    $repoRoot = Normalize-WslPath -Path (($repoRoot | Out-String).Trim())
    if ([string]::IsNullOrWhiteSpace($repoRoot)) {
      Set-RepoRootCacheEntry -State $State -Key $cacheKey -Value $normalizedDirectory
      return $normalizedDirectory
    }

    Set-RepoRootCacheEntry -State $State -Key $cacheKey -Value $repoRoot
    return $repoRoot
  } catch {
    Set-RepoRootCacheEntry -State $State -Key $cacheKey -Value $normalizedDirectory
    return $normalizedDirectory
  }
}

function Convert-ToVscodeRemotePath {
  param(
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return ""
  }

  $normalized = $Path -replace '\\', '/'
  $segments = $normalized -split '/'
  $encodedSegments = foreach ($segment in $segments) {
    [Uri]::EscapeDataString($segment)
  }

  return ($encodedSegments -join '/')
}

function Get-CodeProcessName {
  param(
    [string]$Executable
  )

  $processName = [System.IO.Path]::GetFileNameWithoutExtension($Executable)
  if ([string]::IsNullOrWhiteSpace($processName)) {
    return 'Code'
  }

  return $processName
}

function Get-ForegroundWindowInfo {
  $windowHandle = [VscodeWindow]::GetForegroundWindow()
  if ($windowHandle -eq [IntPtr]::Zero -or -not [VscodeWindow]::IsWindow($windowHandle)) {
    return $null
  }

  [uint32]$processId = 0
  [void][VscodeWindow]::GetWindowThreadProcessId($windowHandle, [ref]$processId)
  if ($processId -eq 0) {
    return $null
  }

  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $null
  }

  return @{
    Hwnd = $windowHandle
    Pid = [int]$processId
    ProcessName = [string]$process.ProcessName
  }
}

function Restore-AndActivateWindow {
  param(
    [IntPtr]$WindowHandle,
    [int]$ProcessId
  )

  if ($WindowHandle -eq [IntPtr]::Zero -or -not [VscodeWindow]::IsWindow($WindowHandle)) {
    return $false
  }

  $showCode = if ([VscodeWindow]::IsIconic($WindowHandle)) { 9 } else { 5 }
  [VscodeWindow]::ShowWindowAsync($WindowHandle, $showCode) | Out-Null
  Start-Sleep -Milliseconds 5

  $foregroundWindow = [VscodeWindow]::GetForegroundWindow()
  [uint32]$foregroundProcessId = 0
  $foregroundThreadId = 0
  if ($foregroundWindow -ne [IntPtr]::Zero) {
    $foregroundThreadId = [VscodeWindow]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)
  }

  [uint32]$targetProcessId = 0
  $targetThreadId = [VscodeWindow]::GetWindowThreadProcessId($WindowHandle, [ref]$targetProcessId)
  $currentThreadId = [VscodeWindow]::GetCurrentThreadId()

  $attachedToForeground = $false
  $attachedToTarget = $false

  try {
    if ($foregroundThreadId -ne 0 -and $foregroundThreadId -ne $currentThreadId) {
      $attachedToForeground = [VscodeWindow]::AttachThreadInput($currentThreadId, $foregroundThreadId, $true)
    }

    if ($targetThreadId -ne 0 -and $targetThreadId -ne $currentThreadId) {
      $attachedToTarget = [VscodeWindow]::AttachThreadInput($currentThreadId, $targetThreadId, $true)
    }

    [VscodeWindow]::BringWindowToTop($WindowHandle) | Out-Null
    [VscodeWindow]::SetActiveWindow($WindowHandle) | Out-Null
    [VscodeWindow]::SetFocus($WindowHandle) | Out-Null

    $wshell = Get-WscriptShell
    $wshell.SendKeys('%')
    Start-Sleep -Milliseconds 5

    if ([VscodeWindow]::SetForegroundWindow($WindowHandle)) {
      return $true
    }
  } finally {
    if ($attachedToTarget) {
      [VscodeWindow]::AttachThreadInput($currentThreadId, $targetThreadId, $false) | Out-Null
    }

    if ($attachedToForeground) {
      [VscodeWindow]::AttachThreadInput($currentThreadId, $foregroundThreadId, $false) | Out-Null
    }
  }

  $wshell = Get-WscriptShell
  return [bool]$wshell.AppActivate($ProcessId)
}

function Try-FocusCachedWindow {
  param(
    [hashtable]$State,
    [string]$Key,
    [string]$ExpectedProcessName
  )

  $entry = Get-WindowCacheEntry -State $State -Key $Key
  if ($null -eq $entry) {
    return $false
  }

  try {
    $windowHandle = [IntPtr]([int64]$entry.Hwnd)
  } catch {
    Remove-WindowCacheEntry -State $State -Key $Key
    return $false
  }
  if ($windowHandle -eq [IntPtr]::Zero -or -not [VscodeWindow]::IsWindow($windowHandle)) {
    Remove-WindowCacheEntry -State $State -Key $Key
    return $false
  }

  [uint32]$processId = 0
  [void][VscodeWindow]::GetWindowThreadProcessId($windowHandle, [ref]$processId)
  if ($processId -eq 0) {
    Remove-WindowCacheEntry -State $State -Key $Key
    return $false
  }

  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.ProcessName -ine $ExpectedProcessName) {
    Remove-WindowCacheEntry -State $State -Key $Key
    return $false
  }

  if (-not [string]::IsNullOrWhiteSpace($entry.ProcessStartTime)) {
    try {
      $cachedStartTime = [DateTime]::Parse($entry.ProcessStartTime).ToUniversalTime()
      $currentStartTime = $process.StartTime.ToUniversalTime()
      if ($currentStartTime -ne $cachedStartTime) {
        Remove-WindowCacheEntry -State $State -Key $Key
        return $false
      }
    } catch {
      Remove-WindowCacheEntry -State $State -Key $Key
      return $false
    }
  }

  if (-not (Restore-AndActivateWindow -WindowHandle $windowHandle -ProcessId $processId)) {
    return $false
  }

  Set-WindowCacheEntry -State $State -Key $Key -ProcessId $processId -WindowHandle $windowHandle
  return $true
}

function Wait-ForCodeForegroundWindow {
  param(
    [string]$ExpectedProcessName,
    [hashtable]$InitialForeground,
    [int]$TimeoutMs = 4000
  )

  $acceptSameWindow = ($null -eq $InitialForeground) -or ($InitialForeground.ProcessName -ine $ExpectedProcessName)
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

  while ($stopwatch.ElapsedMilliseconds -lt $TimeoutMs) {
    $foreground = Get-ForegroundWindowInfo
    if ($null -ne $foreground -and $foreground.ProcessName -ieq $ExpectedProcessName) {
      if ($acceptSameWindow) {
        return $foreground
      }

      if ($foreground.Hwnd.ToInt64() -ne $InitialForeground.Hwnd.ToInt64() -or $foreground.Pid -ne $InitialForeground.Pid) {
        return $foreground
      }
    }

    Start-Sleep -Milliseconds 50
  }

  return $null
}

if ($CodeArg.Count -eq 0) {
  $CodeArg = @('code')
}

$resolvedCachePath = Get-DefaultCachePath
$cacheState = New-CacheState
$targetDir = Normalize-WslPath -Path $RequestedDir
$resolveStopwatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
  $cacheState = Read-CacheState -Path $resolvedCachePath
  $targetDir = Resolve-WorktreeRoot -Directory $RequestedDir -Distribution $Distro -State $cacheState
} catch {
  Write-StructuredLog -Level 'warn' -Category 'alt_o' -Message 'cache-backed target resolution failed' -Fields @{
    requested_dir = $RequestedDir
    distro = $Distro
    error = $_.Exception.Message
  }
  $cacheState = New-CacheState
  $targetDir = Resolve-WorktreeRoot -Directory $RequestedDir -Distribution $Distro -State $cacheState
}
$resolveStopwatch.Stop()

if ([string]::IsNullOrWhiteSpace($targetDir) -or -not $targetDir.StartsWith('/')) {
  Write-StructuredLog -Level 'warn' -Category 'alt_o' -Message 'resolved target dir was invalid; falling back to requested dir' -Fields @{
    requested_dir = $RequestedDir
    resolved_target_dir = [string]$targetDir
    resolve_target_duration_ms = $resolveStopwatch.ElapsedMilliseconds
    total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
  }
  $targetDir = Normalize-WslPath -Path $RequestedDir
}

$folderUri = "vscode-remote://wsl+$([Uri]::EscapeDataString($Distro))$(Convert-ToVscodeRemotePath -Path $targetDir)"
$codeExecutable = $CodeArg[0]
$codeArguments = @()
$codeProcessName = Get-CodeProcessName -Executable $codeExecutable
$windowCacheKey = Get-CacheKey -Distribution $Distro -Path $targetDir

if ($CodeArg.Count -gt 1) {
  $codeArguments = $CodeArg[1..($CodeArg.Count - 1)]
}

Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'resolved vscode target' -Fields @{
  requested_dir = $RequestedDir
  target_dir = $targetDir
  cache_key = $windowCacheKey
  resolve_target_duration_ms = $resolveStopwatch.ElapsedMilliseconds
  total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
}

$focusStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  if (Try-FocusCachedWindow -State $cacheState -Key $windowCacheKey -ExpectedProcessName $codeProcessName) {
    $focusStopwatch.Stop()
    Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'focused cached vscode window' -Fields @{
      target_dir = $targetDir
      cache_key = $windowCacheKey
      focus_cached_window_duration_ms = $focusStopwatch.ElapsedMilliseconds
      total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
    }
    Write-CacheState -State $cacheState -Path $resolvedCachePath
    if ($ReturnResult) {
      return @{
        status = 'focused_cached_window'
        target_dir = $targetDir
        cache_key = $windowCacheKey
        total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
      }
    }
    return
  }
} catch {
  $focusStopwatch.Stop()
  Write-StructuredLog -Level 'warn' -Category 'alt_o' -Message 'cached window focus failed; falling back to launch' -Fields @{
    target_dir = $targetDir
    cache_key = $windowCacheKey
    error = $_.Exception.Message
    focus_cached_window_duration_ms = $focusStopwatch.ElapsedMilliseconds
    total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
  }
}
$focusStopwatch.Stop()

$initialForeground = Get-ForegroundWindowInfo
$launchStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  Start-Process -FilePath $codeExecutable -ArgumentList @($codeArguments + @('--folder-uri', $folderUri))
  $launchStopwatch.Stop()
  Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'launched vscode' -Fields @{
    target_dir = $targetDir
    folder_uri = $folderUri
    code_executable = $codeExecutable
    launch_vscode_duration_ms = $launchStopwatch.ElapsedMilliseconds
    total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
  }
} catch {
  $launchStopwatch.Stop()
  Write-StructuredLog -Level 'error' -Category 'alt_o' -Message 'failed to launch vscode' -Fields @{
    target_dir = $targetDir
    folder_uri = $folderUri
    code_executable = $codeExecutable
    error = $_.Exception.Message
    launch_vscode_duration_ms = $launchStopwatch.ElapsedMilliseconds
    total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
  }
  if ($ReturnResult) {
    return @{
      status = 'launch_failed'
      error = $_.Exception.Message
      target_dir = $targetDir
      folder_uri = $folderUri
      total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
    }
  }
  throw
}

$captureStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $focusedWindow = Wait-ForCodeForegroundWindow -ExpectedProcessName $codeProcessName -InitialForeground $initialForeground
  $captureStopwatch.Stop()
  if ($null -ne $focusedWindow) {
    Set-WindowCacheEntry -State $cacheState -Key $windowCacheKey -ProcessId $focusedWindow.Pid -WindowHandle $focusedWindow.Hwnd
    Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'captured vscode window after launch' -Fields @{
      target_dir = $targetDir
      cache_key = $windowCacheKey
      pid = $focusedWindow.Pid
      hwnd = $focusedWindow.Hwnd.ToInt64()
      wait_for_foreground_duration_ms = $captureStopwatch.ElapsedMilliseconds
      total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
    }
  } else {
    Write-StructuredLog -Level 'info' -Category 'alt_o' -Message 'no vscode foreground window captured after launch' -Fields @{
      target_dir = $targetDir
      cache_key = $windowCacheKey
      wait_for_foreground_duration_ms = $captureStopwatch.ElapsedMilliseconds
      total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
    }
  }
} catch {
  $captureStopwatch.Stop()
  Write-StructuredLog -Level 'warn' -Category 'alt_o' -Message 'post-launch window capture failed' -Fields @{
    target_dir = $targetDir
    cache_key = $windowCacheKey
    error = $_.Exception.Message
    wait_for_foreground_duration_ms = $captureStopwatch.ElapsedMilliseconds
    total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
  }
}

Write-CacheState -State $cacheState -Path $resolvedCachePath
if ($ReturnResult) {
  return @{
    status = 'launched'
    target_dir = $targetDir
    cache_key = $windowCacheKey
    total_duration_ms = $script:AltOStopwatch.ElapsedMilliseconds
  }
}
