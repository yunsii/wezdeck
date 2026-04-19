param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseTag,

  [string]$ReleaseName = ''
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ReleaseTag)) {
  throw 'release tag is required'
}

if ([string]::IsNullOrWhiteSpace($ReleaseName)) {
  $ReleaseName = "Windows host helper $ReleaseTag"
}

$assetName = "wezterm-windows-host-helper-$ReleaseTag-win-x64.zip"

$outputs = [ordered]@{
  release_tag = $ReleaseTag
  release_name = $ReleaseName
  asset_name = $assetName
}

foreach ($entry in $outputs.GetEnumerator()) {
  $line = "$($entry.Key)=$($entry.Value)"
  Write-Output $line
  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value $line
  }
}
