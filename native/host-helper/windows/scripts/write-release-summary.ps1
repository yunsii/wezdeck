param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseTag,

  [Parameter(Mandatory = $true)]
  [string]$AssetName,

  [Parameter(Mandatory = $true)]
  [string]$Sha256,

  [Parameter(Mandatory = $true)]
  [string]$Repository
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$downloadUrl = "https://github.com/$Repository/releases/download/$ReleaseTag/$AssetName"
$summary = @"
Release asset:
- tag: $ReleaseTag
- asset: $AssetName
- sha256: $Sha256
- url: $downloadUrl

Update manifest in a repo checkout:
scripts/dev/update-host-helper-release-manifest.sh --tag $ReleaseTag --sha256 $Sha256 --repo $Repository

Manifest snippet:
{
  "schemaVersion": 1,
  "enabled": true,
  "version": "$ReleaseTag",
  "assetName": "$AssetName",
  "downloadUrl": "$downloadUrl",
  "sha256": "$Sha256"
}
"@

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
  Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $summary
}

Write-Output $summary
