@echo off
setlocal
cd /d "%~dp0"

echo Stopping any existing Alexa Broadcast Client...
powershell -NoProfile -Command "$root = (Resolve-Path '%CD%').Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'alexa-broadcast-client.exe' -and $_.CommandLine -like ('*' + $root + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

ping 127.0.0.1 -n 2 >nul

echo Starting Alexa Broadcast Client...
start "" "%~dp0alexa-broadcast-client.exe"

echo Client launched. You can close this window.
