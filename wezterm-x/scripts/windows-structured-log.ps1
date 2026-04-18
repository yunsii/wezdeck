function Initialize-StructuredLog {
  param(
    [string]$FilePath = '',
    [string]$Enabled = '0',
    [string]$CategoryEnabled = '0',
    [string]$Level = 'info',
    [string]$Source = 'windows-runtime',
    [string]$TraceId = '',
    [int]$MaxBytes = 0,
    [int]$MaxFiles = 0
  )

  $script:StructuredLogConfig = @{
    FilePath = $FilePath
    Enabled = ($Enabled -eq '1')
    CategoryEnabled = ($CategoryEnabled -eq '1')
    Level = $Level
    Source = $Source
    TraceId = $TraceId
    MaxBytes = $MaxBytes
    MaxFiles = $MaxFiles
  }
}

function Get-StructuredLogLevelRank {
  param(
    [string]$Level
  )

  switch ($Level) {
    'error' { return 1 }
    'warn' { return 2 }
    'info' { return 3 }
    'debug' { return 4 }
    default { return 3 }
  }
}

function Escape-StructuredLogValue {
  param(
    [AllowNull()]
    [object]$Value
  )

  if ($null -eq $Value) {
    return '"nil"'
  }

  $text = [string]$Value
  $text = $text.Replace('\', '\\')
  $text = $text.Replace('"', '\"')
  $text = $text.Replace("`n", '\n')
  $text = $text.Replace("`r", '\r')
  $text = $text.Replace("`t", '\t')
  return ('"{0}"' -f $text)
}

function Get-StructuredLogFormattedFields {
  param(
    [hashtable]$Fields
  )

  if ($null -eq $Fields -or $Fields.Count -eq 0) {
    return ''
  }

  $parts = @()
  foreach ($key in @($Fields.Keys | Sort-Object)) {
    $parts += ('{0}={1}' -f $key, (Escape-StructuredLogValue $Fields[$key]))
  }

  return ($parts -join ' ')
}

function Rotate-StructuredLogIfNeeded {
  if ($null -eq $script:StructuredLogConfig) {
    return
  }

  $filePath = $script:StructuredLogConfig.FilePath
  $maxBytes = $script:StructuredLogConfig.MaxBytes
  $maxFiles = $script:StructuredLogConfig.MaxFiles

  if ([string]::IsNullOrWhiteSpace($filePath) -or $maxBytes -le 0 -or $maxFiles -le 0) {
    return
  }

  if (-not (Test-Path -LiteralPath $filePath)) {
    return
  }

  try {
    $fileInfo = Get-Item -LiteralPath $filePath -ErrorAction Stop
    if ($fileInfo.Length -lt $maxBytes) {
      return
    }

    $lastPath = '{0}.{1}' -f $filePath, $maxFiles
    if (Test-Path -LiteralPath $lastPath) {
      Remove-Item -Force -LiteralPath $lastPath -ErrorAction SilentlyContinue
    }

    for ($index = $maxFiles - 1; $index -ge 1; $index--) {
      $source = '{0}.{1}' -f $filePath, $index
      $destination = '{0}.{1}' -f $filePath, ($index + 1)
      if (Test-Path -LiteralPath $source) {
        Move-Item -Force -LiteralPath $source -Destination $destination
      }
    }

    Move-Item -Force -LiteralPath $filePath -Destination ('{0}.1' -f $filePath)
  } catch {
  }
}

function Write-StructuredLog {
  param(
    [string]$Level,
    [string]$Category,
    [string]$Message,
    [hashtable]$Fields = @{}
  )

  if ($null -eq $script:StructuredLogConfig) {
    return
  }

  if (-not $script:StructuredLogConfig.Enabled -or -not $script:StructuredLogConfig.CategoryEnabled) {
    return
  }

  if ((Get-StructuredLogLevelRank $Level) -gt (Get-StructuredLogLevelRank $script:StructuredLogConfig.Level)) {
    return
  }

  $filePath = $script:StructuredLogConfig.FilePath
  if ([string]::IsNullOrWhiteSpace($filePath)) {
    return
  }

  try {
    $directory = Split-Path -Parent $filePath
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
      New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    Rotate-StructuredLogIfNeeded

    $lineFields = @{}
    foreach ($key in @($Fields.Keys)) {
      $lineFields[$key] = $Fields[$key]
    }

    if (-not [string]::IsNullOrWhiteSpace($script:StructuredLogConfig.TraceId)) {
      $lineFields.trace_id = $script:StructuredLogConfig.TraceId
    }

    $line = 'ts={0} level={1} source={2} category={3} message={4}' -f `
      (Escape-StructuredLogValue ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff'))), `
      (Escape-StructuredLogValue $Level), `
      (Escape-StructuredLogValue $script:StructuredLogConfig.Source), `
      (Escape-StructuredLogValue $Category), `
      (Escape-StructuredLogValue $Message)

    $formattedFields = Get-StructuredLogFormattedFields -Fields $lineFields
    if (-not [string]::IsNullOrWhiteSpace($formattedFields)) {
      $line = '{0} {1}' -f $line, $formattedFields
    }

    Add-Content -LiteralPath $filePath -Value $line
  } catch {
  }
}
