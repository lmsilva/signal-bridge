@echo off
setlocal
cd /d "%~dp0"

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
set "VENV_PYW=%~dp0.venv\Scripts\pythonw.exe"
set "VENV_CFG=%~dp0.venv\pyvenv.cfg"

if exist "%~dp0alexa-broadcast-client.exe" (
  set "PORTABLE_EXE=%~dp0alexa-broadcast-client.exe"
  goto LaunchPortable
)
if exist "%~dp0dist\alexa broadcast client\alexa-broadcast-client.exe" (
  set "PORTABLE_EXE=%~dp0dist\alexa broadcast client\alexa-broadcast-client.exe"
  goto LaunchPortable
)

call :StopExisting

if exist "%VENV_PY%" (
  call :ValidateVenv
  if errorlevel 1 (
    echo Removing broken virtual environment...
    rmdir /s /q "%~dp0.venv"
  )
)

if not exist "%VENV_PY%" (
  call :FindSystemPython
  if errorlevel 1 (
    echo.
    echo Python is not installed on this PC.
    echo.
    echo For the movie poster PC, copy the portable build instead:
    echo   dist\alexa broadcast client\
    echo and run "Run Alexa Broadcast Client.bat" there.
    echo.
    echo No Python or pip is required for the portable build.
    echo.
    pause
    exit /b 1
  )
  echo Creating virtual environment...
  %PYTHON% -m venv .venv
  if errorlevel 1 (
    echo Failed to create virtual environment.
    pause
    exit /b 1
  )
)

call :StopExisting
ping 127.0.0.1 -n 2 >nul

"%VENV_PY%" -m pip install -r requirements.txt -q
if errorlevel 1 (
  echo Failed to install dependencies.
  pause
  exit /b 1
)

if exist "%VENV_PYW%" (
  set "LAUNCHER=%VENV_PYW%"
) else (
  set "LAUNCHER=%VENV_PY%"
)

echo Starting Alexa Broadcast Client...
start "" "%LAUNCHER%" -m src.main

echo Client launched. You can close this window.
exit /b 0

:LaunchPortable
call :StopExisting
ping 127.0.0.1 -n 2 >nul
echo Starting Alexa Broadcast Client (portable)...
start "" "%PORTABLE_EXE%"
echo Client launched. You can close this window.
exit /b 0

:StopExisting
echo Stopping any existing Alexa Broadcast Client...
powershell -NoProfile -Command ^
  "$root = (Resolve-Path '%CD%').Path;" ^
  "Get-CimInstance Win32_Process | Where-Object {" ^
  "  ($_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -like ('*' + $root + '*') -and $_.CommandLine -like '*src.main*') -or" ^
  "  ($_.Name -eq 'alexa-broadcast-client.exe' -and $_.CommandLine -like ('*' + $root + '*'))" ^
  "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
exit /b 0

:ValidateVenv
if not exist "%VENV_CFG%" exit /b 1
for /f "usebackq tokens=1,* delims== " %%A in ("%VENV_CFG%") do (
  if /I "%%A"=="home" set "VENV_HOME=%%B"
)
if not defined VENV_HOME exit /b 1
if not exist "%VENV_HOME%\python.exe" exit /b 1
"%VENV_PY%" -c "import sys" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:FindSystemPython
set "PYTHON="
where py >nul 2>&1 && set "PYTHON=py -3"
if not defined PYTHON where python >nul 2>&1 && set "PYTHON=python"
if not defined PYTHON (
  for %%P in (313 312 311 310) do (
    if exist "%LOCALAPPDATA%\Programs\Python\Python%%P\python.exe" (
      set "PYTHON=%LOCALAPPDATA%\Programs\Python\Python%%P\python.exe"
    )
  )
)
if not defined PYTHON exit /b 1
exit /b 0
