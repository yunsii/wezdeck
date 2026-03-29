param(
  [string]$ChromePath = "chrome.exe",
  [int]$RemoteDebuggingPort = 9222,
  [string]$UserDataDir = "$env:LOCALAPPDATA\ChromeDebugProfile"
)

try {
  $existing = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.Contains("--remote-debugging-port=$RemoteDebuggingPort") -and
    $_.CommandLine.Contains($UserDataDir)
  } | Select-Object -First 1

  if ($existing) {
    $process = Get-Process -Id $existing.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) {
      $wshell = New-Object -ComObject WScript.Shell
      $null = $wshell.AppActivate($existing.ProcessId)
      exit 0
    }
  }

  Start-Process -FilePath $ChromePath -ArgumentList @(
    "--remote-debugging-port=$RemoteDebuggingPort",
    "--user-data-dir=$UserDataDir"
  )
} catch {
  exit 1
}
