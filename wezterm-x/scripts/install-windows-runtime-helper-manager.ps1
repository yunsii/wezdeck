param(
  [string]$RuntimeDir = '',

  [string]$InstallRoot = "$env:LOCALAPPDATA\wezterm-runtime-helper\bin"
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Get-ManagerProjectPath {
  param(
    [string]$RuntimeRoot
  )

  if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Split-Path -Parent $PSScriptRoot
  }

  return Join-Path (Split-Path -Parent $RuntimeRoot) '.wezterm-native\host-helper\windows\WezTerm.WindowsHostHelper.csproj'
}

function Get-DotnetPath {
  $command = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $default = 'C:\Program Files\dotnet\dotnet.exe'
  if (Test-Path -LiteralPath $default) {
    return $default
  }

  return $null
}

function Stop-InstalledHelperManagerProcesses {
  param(
    [string]$BinaryPath
  )

  $processName = [System.IO.Path]::GetFileNameWithoutExtension($BinaryPath)
  foreach ($process in @(Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
    try {
      $mainModulePath = $null
      try {
        $mainModulePath = $process.MainModule.FileName
      } catch {
        $mainModulePath = $null
      }

      if ($null -eq $mainModulePath -or $mainModulePath -ieq $BinaryPath) {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
      }
    } catch {
    } finally {
      $process.Dispose()
    }
  }
}

$projectPath = Get-ManagerProjectPath -RuntimeRoot $RuntimeDir
if (-not (Test-Path -LiteralPath $projectPath)) {
  throw "helper manager project missing: $projectPath"
}

$dotnet = Get-DotnetPath
if ([string]::IsNullOrWhiteSpace($dotnet)) {
  throw 'dotnet SDK is not installed on Windows'
}

$projectDir = Split-Path -Parent $projectPath
$tempOutput = Join-Path ([System.IO.Path]::GetTempPath()) ("wezterm-helper-manager-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force -Path $tempOutput
$null = New-Item -ItemType Directory -Force -Path $InstallRoot

Write-Output ("[helper-install] project=" + $projectPath)
Write-Output ("[helper-install] dotnet=" + $dotnet)
Write-Output ("[helper-install] install_root=" + $InstallRoot)
Write-Output ("[helper-install] temp_output=" + $tempOutput)

try {
  & $dotnet publish $projectPath `
    -c Release `
    -r win-x64 `
    --self-contained false `
    /p:PublishSingleFile=false `
    -o $tempOutput

  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
  }

  Write-Output "[helper-install] publish_succeeded=1"
  Stop-InstalledHelperManagerProcesses -BinaryPath (Join-Path $InstallRoot 'helper-manager.exe')
  Write-Output "[helper-install] stopped_existing_manager=1"
  Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
  Copy-Item -Path (Join-Path $tempOutput '*') -Destination $InstallRoot -Recurse -Force
  Write-Output ("[helper-install] installed_binary=" + (Join-Path $InstallRoot 'helper-manager.exe'))
  Write-Output (Join-Path $InstallRoot 'helper-manager.exe')
} finally {
  Remove-Item -LiteralPath $tempOutput -Force -Recurse -ErrorAction SilentlyContinue
}
