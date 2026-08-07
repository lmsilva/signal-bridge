@echo off
setlocal enableextensions

rem One-click deploy for the poster PC.
rem Double-click from the NAS dist share or a local copy — both work.
rem On failure only: prints an error and pauses so you can read it.

rem CMD cannot use a UNC path as its working directory. pushd maps the bat's
rem folder (\\nas\...\dist) to a drive letter so relative paths and tools work.
pushd "%~dp0" 2>nul
if errorlevel 1 (
  echo ERROR: Could not open the folder this script lives in:
  echo   %~dp0
  echo Map a drive to the NAS share, or copy this folder locally, then retry.
  pause
  exit /b 1
)

rem Prefer the zip sitting next to this bat (always current after a rebuild).
set "SRC=%CD%\alexa broadcast client.zip"
if not exist "%SRC%" (
  set "SRC=\\nas\Container\alexa-broadcast-bridge\alexa broadcast client\dist\alexa broadcast client.zip"
)

set "DEST=C:\MoviePoster"
set "APPDIR=%DEST%\alexa broadcast client"
set "LOCALZIP=%TEMP%\alexa-broadcast-client-deploy.zip"
set "EXE=%APPDIR%\alexa-broadcast-client.exe"

if not exist "%SRC%" (
  echo ERROR: Package zip not found.
  echo Looked for:
  echo   %CD%\alexa broadcast client.zip
  echo   \\nas\Container\alexa-broadcast-bridge\alexa broadcast client\dist\alexa broadcast client.zip
  pause
  popd
  exit /b 1
)

echo Stopping any running client...
taskkill /F /IM "alexa-broadcast-client.exe" >nul 2>&1
taskkill /F /IM "webview-host.exe" >nul 2>&1
ping 127.0.0.1 -n 3 >nul

if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1
if exist "%APPDIR%" (
  echo Removing previous install...
  rmdir /s /q "%APPDIR%"
)
if exist "%APPDIR%" (
  echo ERROR: Could not remove "%APPDIR%".
  echo Make sure no window or Explorer view is using it, then retry.
  pause
  popd
  exit /b 1
)

if exist "%LOCALZIP%" del /f /q "%LOCALZIP%" >nul 2>&1

echo Copying package...
copy /y "%SRC%" "%LOCALZIP%" >nul
if errorlevel 1 (
  echo ERROR: Failed to copy the package.
  echo Source: "%SRC%"
  pause
  popd
  exit /b 1
)
if not exist "%LOCALZIP%" (
  echo ERROR: Failed to copy the package.
  echo Source: "%SRC%"
  pause
  popd
  exit /b 1
)

rem Reject a truncated copy (real package is tens of MB).
for %%I in ("%LOCALZIP%") do set "ZIPSIZE=%%~zI"
if not defined ZIPSIZE set "ZIPSIZE=0"
if %ZIPSIZE% LSS 1000000 (
  echo ERROR: Copied zip is too small ^(%ZIPSIZE% bytes^) — copy likely failed.
  echo Source: "%SRC%"
  del /f /q "%LOCALZIP%" >nul 2>&1
  pause
  popd
  exit /b 1
)

echo Extracting to "%DEST%"...
rem Same tool that build_portable.bat uses to create the zip (more reliable than
rem Expand-Archive, and errors are not swallowed).
tar -xf "%LOCALZIP%" -C "%DEST%"
if errorlevel 1 (
  echo tar extract failed — trying Expand-Archive...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -LiteralPath '%LOCALZIP%' -DestinationPath '%DEST%' -Force; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
  if errorlevel 1 (
    echo ERROR: Could not extract the package.
    echo Zip: "%LOCALZIP%"
    del /f /q "%LOCALZIP%" >nul 2>&1
    pause
    popd
    exit /b 1
  )
)
del /f /q "%LOCALZIP%" >nul 2>&1

rem Tolerate a double-nested extract from older zips / tools.
if not exist "%EXE%" if exist "%APPDIR%\alexa broadcast client\alexa-broadcast-client.exe" (
  echo Flattening nested extract folder...
  robocopy "%APPDIR%\alexa broadcast client" "%APPDIR%" /E /MOVE >nul
  if exist "%APPDIR%\alexa broadcast client" rmdir /s /q "%APPDIR%\alexa broadcast client" >nul 2>&1
)

if not exist "%EXE%" (
  echo ERROR: Extraction did not produce the expected client.
  echo Expected: "%EXE%"
  echo.
  echo Contents of "%DEST%":
  dir /b "%DEST%"
  if exist "%APPDIR%" (
    echo.
    echo Contents of "%APPDIR%":
    dir /b "%APPDIR%"
  )
  pause
  popd
  exit /b 1
)

echo Starting client...
rem Start the exe directly (not the launcher bat) so no second console window appears.
start "" "%EXE%"

echo Deploy complete.
popd
endlocal
exit /b 0
