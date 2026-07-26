#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $here 'config.json'
if (-not (Test-Path $configPath)) {
  Write-Error "Missing config.json — copy config.example.json and fill bridgeUrl + secret."
}

$config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
$bridgeUrl = ([string]$config.bridgeUrl).TrimEnd('/')
$secret = [string]$config.secret
$hostname = if ($config.hostname) { [string]$config.hostname } else { $env:COMPUTERNAME }

$appId = 0
try {
  $appId = [int](Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name 'RunningAppID' -ErrorAction Stop).RunningAppID
} catch {
  $appId = 0
}

if ($appId -le 0) {
  Write-Host "No Steam game running (RunningAppID=0); skipping heartbeat."
  exit 0
}

$body = @{
  hostname = $hostname
  appId    = $appId
  secret   = $secret
} | ConvertTo-Json -Compress

$uri = "$bridgeUrl/api/steam/presence"
Write-Host "POST $uri host=$hostname appId=$appId"

if ($config.insecureSkipTlsVerify) {
  add-type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; }
}
"@
  [System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
}

try {
  $response = Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/json'
  Write-Host ($response | ConvertTo-Json -Compress)
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
