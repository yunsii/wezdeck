param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseTag,

  [Parameter(Mandatory = $true)]
  [string]$AssetName,

  [string]$RuntimeIdentifier = 'win-x64',

  [string]$ArchivePath = ''
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
  $scriptsDir = Split-Path -Parent $PSCommandPath
  return [System.IO.Path]::GetFullPath((Join-Path $scriptsDir '..\..\..\..'))
}

$repoRoot = Get-RepoRoot
$managerProject = Join-Path $repoRoot 'native\wezdeck-runtime\windows\src\Runtime\WezDeck.Runtime.csproj'
$clientProject = Join-Path $repoRoot 'native\wezdeck-runtime\windows\src\RuntimeCli\WezDeck.RuntimeCli.csproj'

$tempRoot = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  $env:RUNNER_TEMP
} else {
  [System.IO.Path]::GetTempPath()
}

$managerOut = Join-Path $tempRoot "wezdeck-runtime-$ReleaseTag"
$clientOut = Join-Path $tempRoot "wezdeck-runtime-cli-$ReleaseTag"
$stageDir = Join-Path $tempRoot "wezdeck-runtime-package-$ReleaseTag"

if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
  $ArchivePath = Join-Path $tempRoot $AssetName
}

New-Item -ItemType Directory -Force -Path $managerOut | Out-Null
New-Item -ItemType Directory -Force -Path $clientOut | Out-Null
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

dotnet publish $managerProject `
  -c Release `
  -r $RuntimeIdentifier `
  --self-contained true `
  /p:PublishSingleFile=false `
  -o $managerOut

dotnet publish $clientProject `
  -c Release `
  -r $RuntimeIdentifier `
  --self-contained true `
  /p:PublishSingleFile=false `
  -o $clientOut

Copy-Item -Path (Join-Path $managerOut '*') -Destination $stageDir -Recurse -Force
Copy-Item -Path (Join-Path $clientOut '*') -Destination $stageDir -Recurse -Force

if (-not (Test-Path -LiteralPath (Join-Path $stageDir 'wezdeck-runtime.exe'))) {
  throw 'wezdeck-runtime.exe missing from staged package'
}
if (-not (Test-Path -LiteralPath (Join-Path $stageDir 'wezdeck-runtime-cli.exe'))) {
  throw 'wezdeck-runtime-cli.exe missing from staged package'
}

if (Test-Path -LiteralPath $ArchivePath) {
  Remove-Item -LiteralPath $ArchivePath -Force
}
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $ArchivePath -Force

$sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
$outputs = [ordered]@{
  archive_path = $ArchivePath
  sha256 = $sha256
}

foreach ($entry in $outputs.GetEnumerator()) {
  $line = "$($entry.Key)=$($entry.Value)"
  Write-Output $line
  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value $line
  }
}
