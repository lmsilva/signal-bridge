@echo off
setlocal enableextensions

rem One-click deploy for the poster PC. Runs silently and closes when done.
rem On failure only: prints an error and pauses so you can read it.

set "SRC=\\nas\Container\alexa-broadcast-bridge\alexa broadcast client\dist\alexa broadcast client.zip"
set "DEST=C:\MoviePoster"
set "APPDIR=%DEST%\alexa broadcast client"
set "LOCALZIP=%DEST%\alexa broadcast client.zip"
set "EXE=%APPDIR%\alexa-broadcast-client.exe"

taskkill /F /IM "alexa-broadcast-client.exe" >nul 2>&1
ping 127.0.0.1 -n 3 >nul

if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1
if exist "%APPDIR%" rmdir /s /q "%APPDIR%"
if exist "%APPDIR%" (
  echo ERROR: Could not remove "%APPDIR%".
  echo Make sure no window or Explorer view is using it, then retry.
  pause
  exit /b 1
)
if exist "%LOCALZIP%" del /f /q "%LOCALZIP%" >nul 2>&1

copy /y "%SRC%" "%LOCALZIP%" >nul
if not exist "%LOCALZIP%" (
  echo ERROR: Failed to copy the package from the NAS.
  echo Check that \\nas is reachable from this PC.
  pause
  exit /b 1
)

rem Zip already contains a top-level "alexa broadcast client" folder — expand into %DEST%.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%LOCALZIP%' -DestinationPath '%DEST%' -Force" >nul 2>&1
del /f /q "%LOCALZIP%" >nul 2>&1

if not exist "%EXE%" (
  echo ERROR: Extraction did not produce the expected client.
  echo Expected: "%EXE%"
  pause
  exit /b 1
)

rem Start the exe directly (not the launcher bat) so no second console window appears.
start "" "%EXE%"

endlocal
exit
