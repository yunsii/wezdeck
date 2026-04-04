param(
  [string]$WslDistro,

  [string]$StatePath = "$env:LOCALAPPDATA\wezterm-clipboard-cache\state.env",

  [string]$LogPath = "$env:LOCALAPPDATA\wezterm-clipboard-cache\listener.log",

  [string]$OutputDir = "$env:LOCALAPPDATA\wezterm-clipboard-images",

  [int]$HeartbeatIntervalSeconds = 1,

  [int]$ImageReadRetryCount = 12,

  [int]$ImageReadRetryDelayMs = 100,

  [int]$CleanupMaxAgeHours = 48,

  [int]$CleanupMaxFiles = 32
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Get-NowEpochMilliseconds {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Sanitize-StateValue {
  param(
    [AllowNull()]
    [object]$Value
  )

  if ($null -eq $Value) {
    return ''
  }

  return (($Value.ToString() -replace "`r", ' ' -replace "`n", ' ').Trim())
}

function Ensure-Directory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  $null = New-Item -ItemType Directory -Force -Path $Path
}

function Ensure-ParentDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    Ensure-Directory -Path $parent
  }
}

function Write-ListenerLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if ([string]::IsNullOrWhiteSpace($LogPath)) {
    return
  }

  try {
    Ensure-ParentDirectory -Path $LogPath
    $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    Add-Content -LiteralPath $LogPath -Value "$timestamp $Message"
  } catch {
  }
}

function Convert-WindowsPathToWsl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$WindowsPath,

    [string]$Distribution
  )

  if (-not [string]::IsNullOrWhiteSpace($Distribution)) {
    try {
      $converted = & wsl.exe --distribution $Distribution wslpath -a -u $WindowsPath 2>$null
      if ($LASTEXITCODE -eq 0) {
        $converted = (($converted | Out-String).Trim())
        if (-not [string]::IsNullOrWhiteSpace($converted)) {
          return $converted
        }
      }
    } catch {
    }
  }

  $normalized = $WindowsPath -replace '\\', '/'
  if ($normalized -match '^([A-Za-z]):/(.*)$') {
    $drive = $Matches[1].ToLowerInvariant()
    $remainder = $Matches[2]
    if ([string]::IsNullOrWhiteSpace($remainder)) {
      return "/mnt/$drive"
    }

    return "/mnt/$drive/$remainder"
  }

  return $normalized
}

function Write-StateFile {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$State
  )

  Ensure-ParentDirectory -Path $StatePath

  $heartbeatAtMs = Get-NowEpochMilliseconds
  $State.heartbeat_at_ms = [string]$heartbeatAtMs

  $lines = @(
    'version=1',
    "kind=$(Sanitize-StateValue $State.kind)",
    "sequence=$(Sanitize-StateValue $State.sequence)",
    "updated_at_ms=$(Sanitize-StateValue $State.updated_at_ms)",
    "heartbeat_at_ms=$(Sanitize-StateValue $State.heartbeat_at_ms)",
    "listener_pid=$(Sanitize-StateValue $State.listener_pid)",
    "listener_started_at_ms=$(Sanitize-StateValue $State.listener_started_at_ms)",
    "distro=$(Sanitize-StateValue $State.distro)",
    "windows_path=$(Sanitize-StateValue $State.windows_path)",
    "wsl_path=$(Sanitize-StateValue $State.wsl_path)",
    "last_error=$(Sanitize-StateValue $State.last_error)"
  )

  $tempPath = "$StatePath.tmp"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempPath, ($lines -join "`r`n") + "`r`n", $utf8NoBom)
  Move-Item -Force -LiteralPath $tempPath -Destination $StatePath
  Write-ListenerLog "state kind=$($State.kind) sequence=$($State.sequence) updated_at_ms=$($State.updated_at_ms)"
}

function Initialize-State {
  param(
    [string]$Kind = 'unknown',
    [string]$Sequence = '',
    [string]$WindowsPath = '',
    [string]$WslPath = '',
    [string]$LastError = ''
  )

  $now = [string](Get-NowEpochMilliseconds)
  $script:ClipboardState = @{
    kind = $Kind
    sequence = $Sequence
    updated_at_ms = $now
    heartbeat_at_ms = $now
    listener_pid = [string]$PID
    listener_started_at_ms = $script:ListenerStartedAtMs
    distro = $WslDistro
    windows_path = $WindowsPath
    wsl_path = $WslPath
    last_error = $LastError
  }
}

function Set-ClipboardState {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Kind,

    [string]$Sequence = '',

    [string]$WindowsPath = '',

    [string]$WslPath = '',

    [string]$LastError = ''
  )

  Initialize-State -Kind $Kind -Sequence $Sequence -WindowsPath $WindowsPath -WslPath $WslPath -LastError $LastError
  Write-StateFile -State $script:ClipboardState
}

function Remove-StaleExports {
  if ([string]::IsNullOrWhiteSpace($OutputDir) -or -not (Test-Path -LiteralPath $OutputDir)) {
    return
  }

  $cutoff = (Get-Date).AddHours(-1 * [Math]::Max($CleanupMaxAgeHours, 1))
  $files = @(
    Get-ChildItem -LiteralPath $OutputDir -Filter 'clipboard-*.png' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending
  )

  $keepCount = [Math]::Max($CleanupMaxFiles, 1)
  for ($index = 0; $index -lt $files.Count; $index++) {
    $file = $files[$index]
    if ($file.LastWriteTimeUtc -lt $cutoff -or $index -ge $keepCount) {
      Remove-Item -Force -LiteralPath $file.FullName -ErrorAction SilentlyContinue
    }
  }
}

function Get-ClipboardImageWithRetry {
  $attemptCount = [Math]::Max($ImageReadRetryCount, 1)
  $delayMs = [Math]::Max($ImageReadRetryDelayMs, 1)

  for ($attempt = 1; $attempt -le $attemptCount; $attempt++) {
    $image = [System.Windows.Forms.Clipboard]::GetImage()
    if ($image) {
      if ($attempt -gt 1) {
        Write-ListenerLog "clipboard image became available after retry attempt=$attempt"
      }
      return $image
    }

    if ($attempt -lt $attemptCount) {
      [System.Threading.Thread]::Sleep($delayMs)
    }
  }

  return $null
}

function Refresh-ClipboardState {
  $sequence = ''

  try {
    Write-ListenerLog 'refresh begin'
    $sequence = [ClipboardListenerForm]::GetClipboardSequenceNumber().ToString()

    if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
      Write-ListenerLog "clipboard kind=text sequence=$sequence"
      Set-ClipboardState -Kind 'text' -Sequence $sequence
      return
    }

    Ensure-Directory -Path $OutputDir

    $image = Get-ClipboardImageWithRetry
    if (-not $image) {
      Write-ListenerLog "clipboard image reported but bitmap unavailable after retries sequence=$sequence retry_count=$ImageReadRetryCount retry_delay_ms=$ImageReadRetryDelayMs"
      Set-ClipboardState -Kind 'unknown' -Sequence $sequence -LastError 'Clipboard reported an image, but no bitmap data was available.'
      return
    }

    try {
      $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $fileName = "clipboard-$timestamp-$([guid]::NewGuid().ToString('N').Substring(0, 8)).png"
      $windowsPath = Join-Path $OutputDir $fileName
      $image.Save($windowsPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      if ($image -is [System.IDisposable]) {
        $image.Dispose()
      }
    }

    $wslPath = Convert-WindowsPathToWsl -WindowsPath $windowsPath -Distribution $WslDistro
    Write-ListenerLog "clipboard kind=image sequence=$sequence windows_path=$windowsPath wsl_path=$wslPath"
    Set-ClipboardState -Kind 'image' -Sequence $sequence -WindowsPath $windowsPath -WslPath $wslPath
    Remove-StaleExports
  } catch {
    $message = $_.Exception.Message
    Write-ListenerLog "refresh failed sequence=$sequence error=$message"
    Set-ClipboardState -Kind 'unknown' -Sequence $sequence -LastError $message
  }
}

$script:ListenerStartedAtMs = [string](Get-NowEpochMilliseconds)
Initialize-State

$mutex = $null
$createdNew = $false
$form = $null
$heartbeatTimer = $null

try {
  Write-ListenerLog "listener bootstrap pid=$PID state_path=$StatePath output_dir=$OutputDir"
  $mutex = New-Object System.Threading.Mutex($true, 'Local\WezTermClipboardImageListener', [ref]$createdNew)
  if (-not $createdNew) {
    Write-ListenerLog 'listener already running, exiting early'
    exit 0
  }

  Set-ClipboardState -Kind 'starting'

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  Add-Type -ReferencedAssemblies @(
    'System.dll',
    'System.Windows.Forms.dll',
    'System.Drawing.dll'
  ) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class ClipboardListenerForm : Form
{
    private const int WM_CLIPBOARDUPDATE = 0x031D;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();

    public event EventHandler ClipboardChanged;

    public ClipboardListenerForm()
    {
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.Manual;
        Size = new System.Drawing.Size(1, 1);
        Location = new System.Drawing.Point(-32000, -32000);
        Opacity = 0;
    }

    protected override void SetVisibleCore(bool value)
    {
        base.SetVisibleCore(false);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        AddClipboardFormatListener(Handle);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && IsHandleCreated)
        {
            RemoveClipboardFormatListener(Handle);
        }

        base.Dispose(disposing);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_CLIPBOARDUPDATE)
        {
            var handler = ClipboardChanged;
            if (handler != null)
            {
                handler(this, EventArgs.Empty);
            }
        }

        base.WndProc(ref m);
    }
}
'@

  $form = New-Object ClipboardListenerForm
  $null = $form.Handle
  $form.add_ClipboardChanged({
    Write-ListenerLog 'received WM_CLIPBOARDUPDATE'
    Refresh-ClipboardState
  })

  $heartbeatTimer = New-Object System.Windows.Forms.Timer
  $heartbeatTimer.Interval = [Math]::Max($HeartbeatIntervalSeconds, 1) * 1000
  $heartbeatTimer.add_Tick({
    if ($script:ClipboardState) {
      Write-ListenerLog 'heartbeat tick'
      Write-StateFile -State $script:ClipboardState
    }
  })
  $heartbeatTimer.Start()

  Refresh-ClipboardState
  Write-ListenerLog 'entering message loop'
  [System.Windows.Forms.Application]::Run($form)
} catch {
  $message = $_.Exception.ToString()
  Write-ListenerLog "listener crashed error=$message"
  throw
} finally {
  Write-ListenerLog 'listener shutting down'
  if ($heartbeatTimer) {
    $heartbeatTimer.Stop()
    $heartbeatTimer.Dispose()
  }

  if ($form) {
    $form.Dispose()
  }

  if ($mutex) {
    try {
      $mutex.ReleaseMutex()
    } catch {
    }
    $mutex.Dispose()
  }
}
