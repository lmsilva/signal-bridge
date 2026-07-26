#requires -Version 5.1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$intervalSec = 30
while ($true) {
  try {
    & (Join-Path $here 'report.ps1')
  } catch {
    Write-Host $_.Exception.Message
  }
  Start-Sleep -Seconds $intervalSec
}
