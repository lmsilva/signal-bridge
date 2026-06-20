@echo off
REM Launcher for the movie poster PC - no Python required.
REM Copy the entire "alexa-broadcast-client" folder from dist\ to this PC.

cd /d "%~dp0"

if exist "%~dp0..\dist\alexa-broadcast-client\alexa-broadcast-client.exe" (
  cd /d "%~dp0..\dist\alexa-broadcast-client"
)

if not exist "%~dp0alexa-broadcast-client.exe" (
  echo Portable build not found.
  echo.
  echo On your dev PC, run build_portable.bat, then copy this folder
  echo to the poster PC:
  echo   dist\alexa-broadcast-client\
  echo.
  echo Do NOT copy the .venv folder - it only works on the PC that created it.
  pause
  exit /b 1
)

call "%~dp0Run Alexa Broadcast Client.bat"
