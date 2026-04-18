param(
  [string]$Distro = "Ubuntu-22.04",
  [switch]$Pause,
  [string]$OutputPath = "",
  [string]$RepoRoot = "",
  [double]$TimeoutSeconds = 20.0,
  [string]$LoginShell = "zsh",
  [string]$AgentName = "codex",
  [string[]]$AgentInteractiveArgs = @("--no-alt-screen"),
  [string[]]$AgentVersionArgs = @("--version"),
  [string[]]$AgentHelpArgs = @("--help")
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path $env:TEMP "measure-hybrid-wsl-agent-startup-$timestamp.log"
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = "/home/yuns/github/wezterm-config"
}

$HelperPath = "$RepoRoot/scripts/dev/measure-pty-first-output.py"
$AgentInteractiveCommand = @($AgentName) + $AgentInteractiveArgs
$AgentVersionCommand = @($AgentName) + $AgentVersionArgs
$AgentHelpCommand = @($AgentName) + $AgentHelpArgs

function Convert-ToPosixShellWord {
  param([string]$Value)
  return "'" + ($Value -replace "'", "'`"'`"'") + "'"
}

function Join-PosixShellCommand {
  param([string[]]$CommandParts)
  return (($CommandParts | ForEach-Object { Convert-ToPosixShellWord $_ }) -join " ")
}

$AgentInteractiveShellCommand = Join-PosixShellCommand $AgentInteractiveCommand
$AgentVersionShellCommand = Join-PosixShellCommand $AgentVersionCommand
$AgentHelpShellCommand = Join-PosixShellCommand $AgentHelpCommand

Start-Transcript -Path $OutputPath -Force | Out-Null

function Write-Step {
  param([string]$Text)
  Write-Host ""
  Write-Host "== $Text =="
}

function Invoke-WslStringCapture {
  param(
    [string]$Label,
    [string[]]$Arguments,
    [bool]$ShutdownFirst = $false
  )

  if ($ShutdownFirst) {
    Write-Host ""
    Write-Host "[pre] wsl --shutdown"
    wsl --shutdown | Out-Null
  }

  $joined = ($Arguments | ForEach-Object {
    if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
  }) -join " "

  Write-Host ""
  Write-Host "[cmd] wsl -d $Distro --exec $joined"

  $tempFile = [System.IO.Path]::GetTempFileName()
  try {
    $elapsed = Measure-Command {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        $lines = @(
          & wsl -d $Distro --exec @Arguments 2>&1 |
            ForEach-Object {
              if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $_.ToString()
              }
              else {
                "$_"
              }
            }
        )
      }
      finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }

      $lines | Tee-Object -FilePath $tempFile | Out-Host
    }

    [pscustomobject]@{
      Label = $Label
      ShutdownFirst = $ShutdownFirst
      OuterSeconds = [math]::Round($elapsed.TotalSeconds, 3)
      Captured = Get-Content -Path $tempFile -Raw
    }
  }
  finally {
    Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-WslJsonCapture {
  param(
    [string]$Label,
    [string[]]$Arguments,
    [bool]$ShutdownFirst = $false
  )

  $result = Invoke-WslStringCapture -Label $Label -Arguments $Arguments -ShutdownFirst $ShutdownFirst
  $parsed = $null
  $parseError = ""
  if (-not [string]::IsNullOrWhiteSpace($result.Captured)) {
    try {
      $parsed = $result.Captured | ConvertFrom-Json
    }
    catch {
      $parseError = $_.Exception.Message
    }
  }

  [pscustomobject]@{
    Label = $Label
    ShutdownFirst = $ShutdownFirst
    OuterSeconds = $result.OuterSeconds
    FirstOutputMs = if ($null -ne $parsed.first_output_ms) { [math]::Round([double]$parsed.first_output_ms, 3) } else { $null }
    MatchedOutputMs = if ($null -ne $parsed.matched_output_ms) { [math]::Round([double]$parsed.matched_output_ms, 3) } else { $null }
    TotalRuntimeMs = if ($null -ne $parsed.total_runtime_ms) { [math]::Round([double]$parsed.total_runtime_ms, 3) } else { $null }
    BytesObserved = if ($null -ne $parsed.bytes_observed) { [int]$parsed.bytes_observed } else { $null }
    TimedOut = if ($null -ne $parsed.timed_out) { [bool]$parsed.timed_out } else { $null }
    ExitCode = if ($null -ne $parsed.exit_code) { [int]$parsed.exit_code } else { $null }
    Sample = if ($null -ne $parsed.sample) { "$($parsed.sample)" } else { "" }
    ParseError = $parseError
    Captured = $result.Captured
  }
}

Write-Step "Hybrid WSL/zsh/Agent Startup Measurement"
Write-Host "Distro: $Distro"
Write-Host "RepoRoot: $RepoRoot"
Write-Host "HelperPath: $HelperPath"
Write-Host "LoginShell: $LoginShell"
Write-Host "AgentName: $AgentName"
Write-Host "Cold measurements will run after wsl --shutdown."
Write-Host "Hot measurements reuse the already running WSL instance."

$results = @()

Write-Step "Cold WSL Boundary"
$results += Invoke-WslStringCapture -Label "cold-true" -ShutdownFirst $true -Arguments @("/bin/true")

Write-Step "Hot WSL Boundary"
$results += Invoke-WslStringCapture -Label "hot-true" -Arguments @("/bin/true")

Write-Step "Hot Agent Version"
$results += Invoke-WslStringCapture -Label "hot-agent-version" -Arguments @("/usr/bin/time", "-p", $LoginShell, "-lic", $AgentVersionShellCommand)

Write-Step "Hot Agent Help"
$results += Invoke-WslStringCapture -Label "hot-agent-help" -Arguments @("/usr/bin/time", "-p", $LoginShell, "-lic", $AgentHelpShellCommand)

Write-Step "Hot Agent Interactive First Output"
$results += Invoke-WslJsonCapture -Label "hot-agent-login-first-output" -Arguments @(
  "python3", $HelperPath, "--timeout-seconds", "$TimeoutSeconds", "--", $LoginShell, "-lic", $AgentInteractiveShellCommand
)

Write-Step "Cold zsh Login + Agent First Output"
$results += Invoke-WslJsonCapture -Label "cold-zsh-login-agent-first-output" -ShutdownFirst $true -Arguments @(
  "python3", $HelperPath, "--timeout-seconds", "$TimeoutSeconds", "--", $LoginShell, "-lic", $AgentInteractiveShellCommand
)

Write-Step "Summary"
$results | Format-Table -AutoSize Label, ShutdownFirst, OuterSeconds, FirstOutputMs, TotalRuntimeMs, BytesObserved, TimedOut, ExitCode, ParseError

Write-Host ""
Write-Host "Interpretation:"
Write-Host "- cold-true / hot-true: WSL boundary only."
Write-Host "- hot-agent-version / hot-agent-help: non-interactive agent process startup."
Write-Host "- *first-output rows: time until the first terminal byte from an interactive agent session."
Write-Host "- hot-agent-login-first-output includes login shell startup before the agent launches."
Write-Host "- cold-zsh-login-agent-first-output is closest to opening a fresh WSL-backed tmux pane and then launching the agent."
Write-Host ""
Write-Host "Saved full output to: $OutputPath"

Stop-Transcript | Out-Null

if ($Pause) {
  Write-Host ""
  Read-Host "Press Enter to exit"
}
