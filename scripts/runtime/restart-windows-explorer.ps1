# Restart Windows Explorer heal used by restart-windows-explorer.sh (Ctrl+k e).
# Keep in sync with the bash wrapper toast/log contract: stdout one line
# ok=... pid=... start=... autohide=... wezterm_healed=... tray_topmost=...
# shellhost_recycled=... stuckrects_bounce=... abm=... byte8=... before=...
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ExplorerRestartProbe {
  [DllImport("shell32.dll")] public static extern IntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetProp(IntPtr hWnd, string lpString, IntPtr hData);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hWnd, string lpString);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA {
    public uint cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam;
  }
  public static readonly IntPtr HWND_TOP = IntPtr.Zero;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const int GWL_STYLE = -16;
  public const int GWL_EXSTYLE = -20;
  public const int WS_CAPTION = 0x00C00000;
  public const int WS_THICKFRAME = 0x00040000;
  public const int WS_MAXIMIZE = 0x01000000;
  public const int WS_EX_TOPMOST = 0x00000008;
  public const int SW_RESTORE = 9;
  public const int SW_MAXIMIZE = 3;
}
"@

function Get-AbmState {
  $abd = New-Object ExplorerRestartProbe+APPBARDATA
  $abd.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($abd)
  try { return [int][ExplorerRestartProbe]::SHAppBarMessage(4, [ref]$abd).ToInt64() } catch { return -1 }
}

function Get-StuckRectsByte8 {
  $srPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3"
  try {
    $settings = [byte[]](Get-ItemProperty -Path $srPath -Name Settings -ErrorAction Stop).Settings
    if ($settings.Length -gt 8) { return [int]$settings[8] }
  } catch {}
  return -1
}

function Recycle-Shell {
  Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-Process ShellHost,ShellExperienceHost,StartMenuExperienceHost,SearchHost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700
  if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }
  $deadline = (Get-Date).AddSeconds(10)
  do { Start-Sleep -Milliseconds 200 } while (-not (Get-Process explorer -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline))
  Start-Sleep -Milliseconds 500
}

# Wait for Shell_TrayWnd and a stable ABM reading. A bare post-recycle ABM
# sample often reports autohide=off while StuckRects3 byte8 still means on.
function Wait-ShellAbmSettled {
  $deadline = (Get-Date).AddSeconds(5)
  $last = -2
  $stable = 0
  do {
    $tray = [ExplorerRestartProbe]::FindWindow("Shell_TrayWnd", $null)
    $abm = Get-AbmState
    if (($tray -ne [IntPtr]::Zero) -and ($abm -ge 0)) {
      if ($abm -eq $last) { $stable++ } else { $stable = 0; $last = $abm }
      if ($stable -ge 2) { return $abm }
    } else {
      $stable = 0
      $last = -2
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return (Get-AbmState)
}

function Resolve-AutohideOn([int]$abm, [int]$byte8) {
  $abmOn = (($abm -band 1) -ne 0)
  if ($abmOn) { return $true }
  # Host encoding: byte8=3 on, 2 off (docs). If blob still says on but ABM
  # raced to off, treat as on so StuckRects bounce still runs.
  if ($byte8 -eq 3) { return $true }
  if ($byte8 -eq 2) { return $false }
  return $false
}

# Standing preference: WezTerm stays maximized. Use SWP_NOZORDER so sizing /
# remamaximize does not raise WezTerm above the auto-hide tray.
function Remaximize-WezTermHandles([IntPtr[]]$handles) {
  if ($null -eq $handles -or $handles.Count -eq 0) { return 0 }
  Add-Type -AssemblyName System.Windows.Forms
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $posFlags = [ExplorerRestartProbe]::SWP_NOZORDER -bor [ExplorerRestartProbe]::SWP_FRAMECHANGED -bor [ExplorerRestartProbe]::SWP_SHOWWINDOW -bor [ExplorerRestartProbe]::SWP_NOACTIVATE
  $n = 0
  foreach ($h in $handles) {
    if ($h -eq [IntPtr]::Zero) { continue }
    if ([ExplorerRestartProbe]::IsZoomed($h)) { continue }
    $style = [ExplorerRestartProbe]::GetWindowLongPtr($h, [ExplorerRestartProbe]::GWL_STYLE).ToInt64()
    $style = $style -bor [ExplorerRestartProbe]::WS_CAPTION -bor [ExplorerRestartProbe]::WS_THICKFRAME
    [void][ExplorerRestartProbe]::ShowWindow($h, [ExplorerRestartProbe]::SW_RESTORE)
    Start-Sleep -Milliseconds 120
    [void][ExplorerRestartProbe]::SetWindowLongPtr($h, [ExplorerRestartProbe]::GWL_STYLE, [IntPtr]$style)
    [void][ExplorerRestartProbe]::SetWindowPos($h, [IntPtr]::Zero, $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height, $posFlags)
    Start-Sleep -Milliseconds 120
    [void][ExplorerRestartProbe]::ShowWindow($h, [ExplorerRestartProbe]::SW_MAXIMIZE)
    $n++
  }
  return $n
}

# Mark wezterm-gui as NonRudeHWND so Win11 Rude Window Manager does not treat
# borderless maximized WezTerm (window_decorations=RESIZE) as exclusive
# fullscreen and demote the auto-hide tray. Documented on
# ITaskbarList2::MarkFullscreenWindow since Windows 7. A property change after
# the shell already decided may need a restore→maximize to re-evaluate.
# Exclusive-fullscreen games are a different case (they should stay "rude");
# WezTerm still wants tray badges / hover — that is this mark.
function Mark-WezTermNonRude {
  Add-Type -AssemblyName System.Windows.Forms
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $posFlags = [ExplorerRestartProbe]::SWP_NOZORDER -bor [ExplorerRestartProbe]::SWP_FRAMECHANGED -bor [ExplorerRestartProbe]::SWP_SHOWWINDOW -bor [ExplorerRestartProbe]::SWP_NOACTIVATE
  $n = 0
  Get-Process wezterm-gui -ErrorAction SilentlyContinue | ForEach-Object {
    $h = [IntPtr]$_.MainWindowHandle
    if ($h -eq [IntPtr]::Zero) { return }
    [void][ExplorerRestartProbe]::SetProp($h, "NonRudeHWND", [IntPtr]1)
    $wasZoomed = [ExplorerRestartProbe]::IsZoomed($h)
    [void][ExplorerRestartProbe]::ShowWindow($h, [ExplorerRestartProbe]::SW_RESTORE)
    Start-Sleep -Milliseconds 100
    $style = [ExplorerRestartProbe]::GetWindowLongPtr($h, [ExplorerRestartProbe]::GWL_STYLE).ToInt64()
    $style = $style -bor [ExplorerRestartProbe]::WS_CAPTION -bor [ExplorerRestartProbe]::WS_THICKFRAME
    [void][ExplorerRestartProbe]::SetWindowLongPtr($h, [ExplorerRestartProbe]::GWL_STYLE, [IntPtr]$style)
    [void][ExplorerRestartProbe]::SetWindowPos($h, [IntPtr]::Zero, $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height, $posFlags)
    Start-Sleep -Milliseconds 80
    if ($wasZoomed) {
      [void][ExplorerRestartProbe]::ShowWindow($h, [ExplorerRestartProbe]::SW_MAXIMIZE)
    }
    $n++
  }
  return $n
}

# Re-arm Shell_TrayWnd as topmost. Measured on this host: with tray TOPMOST
# stuck, a true maximized WezTerm still leaves bottom-edge hit-testing on
# Shell_TrayWnd (no need to forbid maximize / leave a permanent gap). A plain
# HWND_TOPMOST often fails to stick on Win11; toggle NOTOPMOST -> TOPMOST +
# WS_EX_TOPMOST does. After StuckRects bounce the new tray often clears the
# bit for ~1s — retry FindWindow + toggle until WS_EX_TOPMOST sticks.
# Call this LAST after any WezTerm remamaximize.
function Assert-TrayTopmost {
  $flags = [ExplorerRestartProbe]::SWP_NOMOVE -bor [ExplorerRestartProbe]::SWP_NOSIZE -bor [ExplorerRestartProbe]::SWP_NOACTIVATE -bor [ExplorerRestartProbe]::SWP_SHOWWINDOW -bor [ExplorerRestartProbe]::SWP_FRAMECHANGED
  $deadline = (Get-Date).AddSeconds(4)
  $attempts = 0
  do {
    $attempts++
    $tray = [ExplorerRestartProbe]::FindWindow("Shell_TrayWnd", $null)
    if ($tray -eq [IntPtr]::Zero) {
      Start-Sleep -Milliseconds 200
      continue
    }
    [void][ExplorerRestartProbe]::SetWindowPos($tray, [ExplorerRestartProbe]::HWND_NOTOPMOST, 0, 0, 0, 0, $flags)
    $ex = [ExplorerRestartProbe]::GetWindowLongPtr($tray, [ExplorerRestartProbe]::GWL_EXSTYLE).ToInt64()
    [void][ExplorerRestartProbe]::SetWindowLongPtr($tray, [ExplorerRestartProbe]::GWL_EXSTYLE, [IntPtr]($ex -bor [ExplorerRestartProbe]::WS_EX_TOPMOST))
    [void][ExplorerRestartProbe]::SetWindowPos($tray, [ExplorerRestartProbe]::HWND_TOPMOST, 0, 0, 0, 0, $flags)
    $abd = New-Object ExplorerRestartProbe+APPBARDATA
    $abd.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($abd)
    $abd.hWnd = $tray
    # ABM_ACTIVATE=6, ABM_WINDOWPOSCHANGED=9
    try { [void][ExplorerRestartProbe]::SHAppBarMessage(6, [ref]$abd) } catch {}
    try { [void][ExplorerRestartProbe]::SHAppBarMessage(9, [ref]$abd) } catch {}
    Start-Sleep -Milliseconds 150
    # Re-resolve hwnd — bounce can replace the tray between Set and check.
    $tray2 = [ExplorerRestartProbe]::FindWindow("Shell_TrayWnd", $null)
    if ($tray2 -eq [IntPtr]::Zero) { $tray2 = $tray }
    $ex2 = [ExplorerRestartProbe]::GetWindowLongPtr($tray2, [ExplorerRestartProbe]::GWL_EXSTYLE).ToInt64()
    if (($ex2 -band [ExplorerRestartProbe]::WS_EX_TOPMOST) -ne 0) {
      return "ok_n$attempts"
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return "fail_n$attempts"
}

Add-Type -AssemblyName System.Windows.Forms
$bounds0 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$maximizeAgain = New-Object System.Collections.Generic.List[IntPtr]
Get-Process wezterm-gui -ErrorAction SilentlyContinue | ForEach-Object {
  $h = [IntPtr]$_.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { return }
  $wr = New-Object ExplorerRestartProbe+RECT
  [void][ExplorerRestartProbe]::GetWindowRect($h, [ref]$wr)
  $fullish = (($wr.Right - $wr.Left) -ge ($bounds0.Width - 8)) -and (($wr.Bottom - $wr.Top) -ge ($bounds0.Height - 8))
  if ([ExplorerRestartProbe]::IsZoomed($h) -or $fullish) { [void]$maximizeAgain.Add($h) }
}

$before = @(Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$beforeShellHost = @(Get-Process ShellHost -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
Recycle-Shell
$abm = Wait-ShellAbmSettled
$byte8 = Get-StuckRectsByte8

$afterProcs = @(Get-Process explorer -ErrorAction SilentlyContinue)
$after = @($afterProcs | ForEach-Object { $_.Id })
$newIds = @($after | Where-Object { $before -notcontains $_ })
$ok = ($newIds.Count -gt 0) -or (($before.Count -eq 0) -and ($after.Count -gt 0))
$afterShellHost = @(Get-Process ShellHost -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$shellhostRecycled = (@($afterShellHost | Where-Object { $beforeShellHost -notcontains $_ }).Count -gt 0) -or (($beforeShellHost.Count -gt 0) -and ($afterShellHost.Count -gt 0) -and ($beforeShellHost[0] -ne $afterShellHost[0]))

$autohideOn = Resolve-AutohideOn $abm $byte8
$autohide = if ($autohideOn) { "on" } else { "off" }
$start = if ($afterProcs.Count -gt 0) { $afterProcs[0].StartTime.ToString("HH:mm:ss") } else { "none" }
$pidOut = if ($after.Count -gt 0) { ($after -join ",") } else { "none" }

$bounce = "skip"
$healed = 0
$trayTopmost = "skip"
$nonrude = 0

if ($autohideOn) {
  # Bounce StuckRects3 byte8 using ABM to learn which of {2,3} means on.
  $srPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3"
  try {
    $settings = [byte[]](Get-ItemProperty -Path $srPath -Name Settings -ErrorAction Stop).Settings
    if ($settings.Length -gt 8) {
      $onByte = [int]$settings[8]
      # When ABM says on, current byte8 is the live "on" value. When ABM raced
      # off but StuckRects still says 3 (this host on), force 3<->2.
      if ((($abm -band 1) -ne 0) -and (($onByte -eq 2) -or ($onByte -eq 3))) {
        $offByte = if ($onByte -eq 3) { 2 } else { 3 }
      } elseif (($onByte -eq 3) -and (-not ((($abm -band 1) -ne 0)))) {
        $offByte = 2
      } else {
        $offByte = -1
      }
      if ($offByte -lt 0) {
        $bounce = "skip_byte8_$onByte"
      } else {
        $bak = [byte[]]@($settings)
        $off = [byte[]]@($settings); $off[8] = [byte]$offByte
        Set-ItemProperty -Path $srPath -Name Settings -Value $off
        Recycle-Shell
        $abmMid = Wait-ShellAbmSettled
        if (($abmMid -band 1) -ne 0) {
          # Encoding guess wrong — restore blob and stop bouncing.
          Set-ItemProperty -Path $srPath -Name Settings -Value $bak
          Recycle-Shell
          [void](Wait-ShellAbmSettled)
          $bounce = "abort_encoding"
        } else {
          $on = [byte[]]@(Get-ItemProperty -Path $srPath -Name Settings).Settings
          $on[8] = [byte]$onByte
          Set-ItemProperty -Path $srPath -Name Settings -Value $on
          Recycle-Shell
          $abmEnd = Wait-ShellAbmSettled
          if (($abmEnd -band 1) -eq 0) {
            Set-ItemProperty -Path $srPath -Name Settings -Value $bak
            Recycle-Shell
            [void](Wait-ShellAbmSettled)
            $bounce = "abort_restore"
          } else {
            $bounce = "ok_${offByte}_to_${onByte}"
            $autohideOn = $true
            $autohide = "on"
            $afterProcs = @(Get-Process explorer -ErrorAction SilentlyContinue)
            $after = @($afterProcs | ForEach-Object { $_.Id })
            $pidOut = if ($after.Count -gt 0) { ($after -join ",") } else { "none" }
            $start = if ($afterProcs.Count -gt 0) { $afterProcs[0].StartTime.ToString("HH:mm:ss") } else { "none" }
          }
        }
      }
    } else {
      $bounce = "skip_short_blob"
    }
  } catch {
    $bounce = "skip_err"
  }
  # Standing state is maximized — remamaximize if mid-heal left a restored
  # window, then put the tray above it. Do not leave a permanent bottom gap.
  $remaxTargets = New-Object System.Collections.Generic.List[IntPtr]
  foreach ($h in @($maximizeAgain)) { if ($h -ne [IntPtr]::Zero) { [void]$remaxTargets.Add($h) } }
  $boundsNow = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  Get-Process wezterm-gui -ErrorAction SilentlyContinue | ForEach-Object {
    $h = [IntPtr]$_.MainWindowHandle
    if ($h -eq [IntPtr]::Zero) { return }
    if ($remaxTargets.Contains($h)) { return }
    $wr = New-Object ExplorerRestartProbe+RECT
    [void][ExplorerRestartProbe]::GetWindowRect($h, [ref]$wr)
    $fullish = (($wr.Right - $wr.Left) -ge ($boundsNow.Width - 8)) -and (($wr.Bottom - $wr.Top) -ge ($boundsNow.Height - 8))
    if ([ExplorerRestartProbe]::IsZoomed($h) -or $fullish) { [void]$remaxTargets.Add($h) }
  }
  $nonrude = Mark-WezTermNonRude
  $healed = $healed + (Remaximize-WezTermHandles @($remaxTargets))
  $trayTopmost = Assert-TrayTopmost
} else {
  $tray = [ExplorerRestartProbe]::FindWindow("Shell_TrayWnd", $null)
  $trayRect = New-Object ExplorerRestartProbe+RECT
  if ($tray -ne [IntPtr]::Zero) { [void][ExplorerRestartProbe]::GetWindowRect($tray, [ref]$trayRect) }
  Add-Type -AssemblyName System.Windows.Forms
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  Get-Process wezterm-gui -ErrorAction SilentlyContinue | ForEach-Object {
    $h = [IntPtr]$_.MainWindowHandle
    if ($h -eq [IntPtr]::Zero) { return }
    $wr = New-Object ExplorerRestartProbe+RECT
    [void][ExplorerRestartProbe]::GetWindowRect($h, [ref]$wr)
    $covers = ($tray -ne [IntPtr]::Zero) -and ($wr.Bottom -ge $trayRect.Top) -and ($wr.Top -le 0) -and (($wr.Bottom - $wr.Top) -gt $wa.Height)
    if (-not $covers) { return }
    $style = [ExplorerRestartProbe]::GetWindowLongPtr($h, [ExplorerRestartProbe]::GWL_STYLE).ToInt64()
    $style = $style -bor [ExplorerRestartProbe]::WS_CAPTION -bor [ExplorerRestartProbe]::WS_THICKFRAME
    [void][ExplorerRestartProbe]::ShowWindow($h, [ExplorerRestartProbe]::SW_RESTORE)
    Start-Sleep -Milliseconds 150
    [void][ExplorerRestartProbe]::SetWindowLongPtr($h, [ExplorerRestartProbe]::GWL_STYLE, [IntPtr]$style)
    $posFlags = [ExplorerRestartProbe]::SWP_NOZORDER -bor [ExplorerRestartProbe]::SWP_FRAMECHANGED -bor [ExplorerRestartProbe]::SWP_SHOWWINDOW -bor [ExplorerRestartProbe]::SWP_NOACTIVATE
    [void][ExplorerRestartProbe]::SetWindowPos($h, [IntPtr]::Zero, $wa.X, $wa.Y, $wa.Width, $wa.Height, $posFlags)
    Start-Sleep -Milliseconds 150
    [void][ExplorerRestartProbe]::ShowWindow($h, [ExplorerRestartProbe]::SW_MAXIMIZE)
    $healed++
  }
  $remax = Remaximize-WezTermHandles @($maximizeAgain)
  $healed = $healed + $remax
}

Write-Output ("ok=" + $ok + " pid=" + $pidOut + " start=" + $start + " autohide=" + $autohide + " wezterm_healed=" + $healed + " nonrude=" + $nonrude + " tray_topmost=" + $trayTopmost + " shellhost_recycled=" + $shellhostRecycled + " stuckrects_bounce=" + $bounce + " abm=" + $abm + " byte8=" + $byte8 + " before=" + (($before -join ",") -replace "^$","none"))
