# Microbench: Windows-side file read latency for /mnt/c (Windows-local
# NTFS) vs \\wsl$\<distro>\... (cross-boundary 9P into WSL ext4).
#
# Models the wezterm.exe / Lua attention.lua reload_state hot path:
# both .json files are read on every wezterm update-status tick (4 Hz).
# Knowing the cost from this side decides whether we should migrate
# attention.json + live-panes.json to WSL native (Phase 3, dependent on
# this measurement).
#
# Invoked from WSL via:
#   source scripts/runtime/windows-shell-lib.sh
#   windows_run_powershell_script_utf8 \
#     "$(wslpath -w scripts/dev/bench-wezterm-side-fs.ps1)" \
#     -DistroName Ubuntu-24.04 -Iterations 200

param(
  [string]$DistroName = 'Ubuntu-24.04',
  [int]$Iterations = 200,
  [int]$Warmup = 10
)

$ErrorActionPreference = 'Stop'

# Test files: prefer the actual attention state JSON if present; fall
# back to a synthesized fixture so the bench works on a fresh machine.
$WindowsPath = Join-Path $env:LOCALAPPDATA 'wezterm-runtime\state\agent-attention\attention.json'
$WslMirrorPath = "\\wsl`$\$DistroName\tmp\bench-attention-mirror.json"

if (-not (Test-Path -LiteralPath $WindowsPath)) {
  Write-Host "bench: source file missing, generating /tmp fixture for both sides"
  $fixture = '{"version":1,"entries":{"x":{"session_id":"x","status":"running","ts":1}}}'
  $WindowsPath = Join-Path $env:TEMP 'bench-attention-fixture.json'
  Set-Content -LiteralPath $WindowsPath -Value $fixture -Encoding UTF8 -NoNewline
}

# Mirror to WSL ext4 (\\wsl$ path resolves through WSL's 9P server).
Copy-Item -LiteralPath $WindowsPath -Destination $WslMirrorPath -Force

function Measure-Reads {
  param([string]$Path, [int]$N)
  $samplesUs = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $N; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $null = [System.IO.File]::ReadAllText($Path)
    $sw.Stop()
    [void]$samplesUs.Add($sw.Elapsed.TotalMilliseconds * 1000.0)
  }
  return $samplesUs
}

function Report {
  param([string]$Label, $SamplesUs)
  $sorted = $SamplesUs | Sort-Object
  $n = $sorted.Count
  $minUs = $sorted[0]
  $maxUs = $sorted[$n - 1]
  $p50Us = $sorted[[int]([Math]::Floor(($n - 1) * 0.50))]
  $p95Us = $sorted[[int]([Math]::Floor(($n - 1) * 0.95))]
  $meanUs = ($sorted | Measure-Object -Average).Average
  '{0,-40} min={1,5:N2}ms  p50={2,5:N2}ms  p95={3,5:N2}ms  max={4,6:N2}ms  mean={5,5:N2}ms' -f `
    $Label, ($minUs / 1000), ($p50Us / 1000), ($p95Us / 1000), ($maxUs / 1000), ($meanUs / 1000)
}

# Warmup both sides so we measure steady-state caches, not cold I/O.
Write-Host "bench: warmup ($Warmup reads each side)..."
[void](Measure-Reads -Path $WindowsPath -N $Warmup)
[void](Measure-Reads -Path $WslMirrorPath -N $Warmup)

Write-Host "bench: timed ($Iterations reads each side)..."
$winSamples = Measure-Reads -Path $WindowsPath -N $Iterations
$wslSamples = Measure-Reads -Path $WslMirrorPath -N $Iterations

Write-Host ""
Write-Host "=== wezterm.exe-side file read latency ==="
Report -Label "Windows NTFS  (%LOCALAPPDATA%)" -SamplesUs $winSamples
Report -Label "WSL ext4      (\\wsl`$\$DistroName)" -SamplesUs $wslSamples

# Cleanup mirror (don't pollute WSL /tmp).
Remove-Item -LiteralPath $WslMirrorPath -Force -ErrorAction SilentlyContinue
