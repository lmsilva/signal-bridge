@echo off
setlocal enableextensions

rem ===========================================================================
rem  Alexa Broadcast Client - one-click deploy
rem  Run this ON the destination (poster) PC. It will:
rem    1. kill any running client
rem    2. remove the existing C:\MoviePoster\alexa broadcast client folder
rem    3. copy the packaged zip from the NAS
rem    4. extract it to C:\MoviePoster\alexa broadcast client
rem    5. launch the client and exit
rem ===========================================================================

set "SRC=\\nas\Container\alexa-broadcast-bridge\alexa broadcast client\dist\alexa broadcast client.zip"
set "DEST=C:\MoviePoster"
set "APPDIR=%DEST%\alexa broadcast client"
set "LOCALZIP=%DEST%\alexa broadcast client.zip"
set "LAUNCHER=%APPDIR%\Run Alexa Broadcast Client.bat"

echo ============================================
echo   Alexa Broadcast Client - Deploy
echo ============================================

echo.
echo [1/5] Stopping any running client...
taskkill /F /IM "alexa-broadcast-client.exe" >nul 2>&1
if "%errorlevel%"=="0" (
  echo       Stopped a running client.
) else (
  echo       No running client found.
)
rem Give Windows a moment to release file locks before we delete files.
ping 127.0.0.1 -n 3 >nul

echo.
echo [2/5] Preparing "%DEST%" ...
if not exist "%DEST%" mkdir "%DEST%"
if exist "%APPDIR%" (
  echo       Removing existing "%APPDIR%" ...
  rmdir /s /q "%APPDIR%"
)
if exist "%APPDIR%" (
  echo ERROR: Could not remove "%APPDIR%".
  echo        Make sure no window or Explorer view is using it, then retry.
  pause
  exit /b 1
)
if exist "%LOCALZIP%" del /f /q "%LOCALZIP%" >nul 2>&1

echo.
echo [3/5] Copying package from NAS...
echo       %SRC%
copy /y "%SRC%" "%LOCALZIP%" >nul
if not exist "%LOCALZIP%" (
  echo ERROR: Failed to copy the package from the NAS.
  echo        Check that \\nas is reachable from this PC.
  pause
  exit /b 1
)

echo.
echo [4/5] Extracting to "%APPDIR%" ...
rem The zip already contains a top-level "alexa broadcast client" folder, so we
rem expand into %DEST% (NOT %APPDIR%) to avoid a nested duplicate subfolder.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%LOCALZIP%' -DestinationPath '%DEST%' -Force"
if not exist "%LAUNCHER%" (
  echo ERROR: Extraction did not produce the expected client folder.
  echo        Expected: "%LAUNCHER%"
  pause
  exit /b 1
)
rem Clean up the local copy of the zip.
del /f /q "%LOCALZIP%" >nul 2>&1

echo.
echo [5/5] Launching client...
start "" "%LAUNCHER%"

echo.
echo Deployment complete. The client is starting.
endlocal
exit /b 0
