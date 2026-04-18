param(
  [string]$Distro = "Ubuntu-22.04",
  [switch]$Pause,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path $env:TEMP "measure-wsl-zsh-startup-$timestamp.log"
}

Start-Transcript -Path $OutputPath -Force | Out-Null

function Write-Step {
  param([string]$Text)
  Write-Host ""
  Write-Host "== $Text =="
}

function Invoke-WslMeasured {
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

    $captured = Get-Content -Path $tempFile -Raw
    $zshStartup = $null
    $innerReal = $null

    if ($captured -match '\[zsh-startup\]\s+([0-9.]+)s') {
      $zshStartup = [double]$Matches[1]
    }

    if ($captured -match '(?m)^real\s+([0-9.]+)$') {
      $innerReal = [double]$Matches[1]
    }

    [pscustomobject]@{
      Label = $Label
      ShutdownFirst = $ShutdownFirst
      OuterSeconds = [math]::Round($elapsed.TotalSeconds, 3)
      InnerRealSeconds = if ($null -ne $innerReal) { [math]::Round($innerReal, 3) } else { $null }
      ZshStartupSeconds = if ($null -ne $zshStartup) { [math]::Round($zshStartup, 3) } else { $null }
      ExtraSeconds = if (($null -ne $innerReal) -and ($null -ne $elapsed.TotalSeconds)) {
        [math]::Round($elapsed.TotalSeconds - $innerReal, 3)
      } else {
        $null
      }
    }
  }
  finally {
    Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
  }
}

Write-Step "WSL/Zsh Startup Measurement"
Write-Host "Distro: $Distro"
Write-Host "Cold measurements will run after wsl --shutdown."
Write-Host "Hot measurements reuse the already running WSL instance."

$results = @()

Write-Step "Cold WSL Boundary"
$results += Invoke-WslMeasured -Label "cold-true" -ShutdownFirst $true -Arguments @("/bin/true")

Write-Step "Cold WSL + zsh"
$results += Invoke-WslMeasured -Label "cold-zsh-login" -ShutdownFirst $true -Arguments @("zsh", "-lic", "exit")

Write-Step "Hot WSL Boundary"
$results += Invoke-WslMeasured -Label "hot-true" -Arguments @("/bin/true")

Write-Step "Hot WSL + zsh"
$results += Invoke-WslMeasured -Label "hot-zsh-login" -Arguments @("zsh", "-lic", "exit")

Write-Step "Hot WSL + zsh With Inner time"
$results += Invoke-WslMeasured -Label "hot-zsh-login-inner-time" -Arguments @("/usr/bin/time", "-p", "zsh", "-lic", "exit")

Write-Step "Hot WSL + bare zsh With Inner time"
$results += Invoke-WslMeasured -Label "hot-zsh-bare-inner-time" -Arguments @("/usr/bin/time", "-p", "zsh", "-flic", "exit")

Write-Step "Summary"
$results | Format-Table -AutoSize Label, ShutdownFirst, OuterSeconds, InnerRealSeconds, ZshStartupSeconds, ExtraSeconds

Write-Host ""
Write-Host "Interpretation:"
Write-Host "- cold-true: pure cold WSL startup cost."
Write-Host "- cold-zsh-login: cold WSL + your normal zsh startup."
Write-Host "- hot-true: pure hot WSL boundary cost."
Write-Host "- hot-zsh-login: hot WSL + your normal zsh startup."
Write-Host "- inner-time rows: compare OuterSeconds vs InnerRealSeconds."
Write-Host "  ExtraSeconds is the rough cost outside the zsh process itself."
Write-Host ""
Write-Host "Saved full output to: $OutputPath"

Stop-Transcript | Out-Null

if ($Pause) {
  Write-Host ""
  Read-Host "Press Enter to exit"
}
