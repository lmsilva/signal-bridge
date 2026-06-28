@echo off
setlocal EnableExtensions
pushd "%~dp0"

set "BUILD_VENV=%LOCALAPPDATA%\alexa-broadcast-client-build-venv"
set "VENV_PY=%BUILD_VENV%\Scripts\python.exe"

set "PYTHON="
where py >nul 2>&1 && set "PYTHON=py -3"
if not defined PYTHON where python >nul 2>&1 && set "PYTHON=python"
if not defined PYTHON if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYTHON (
  echo Python not found. Install Python 3.10+ from https://www.python.org/downloads/
  pause
  popd
  exit /b 1
)

if exist "%VENV_PY%" (
  call :CheckPip
  if errorlevel 1 (
    echo Removing broken build environment...
    rmdir /s /q "%BUILD_VENV%"
  )
)

if not exist "%VENV_PY%" (
  echo Creating build environment at:
  echo   %BUILD_VENV%
  %PYTHON% -m venv "%BUILD_VENV%"
  if errorlevel 1 (
    echo Failed to create build virtual environment.
    pause
    popd
    exit /b 1
  )
)

echo Installing build dependencies...
"%VENV_PY%" -m pip install --upgrade pip
if errorlevel 1 goto PipFailed
"%VENV_PY%" -m pip install -r requirements-build.txt
if errorlevel 1 goto PipFailed

echo.
echo Building portable Alexa Broadcast Client...
"%VENV_PY%" -m PyInstaller --noconfirm alexa-broadcast-client.spec
if errorlevel 1 (
  echo Build failed.
  pause
  popd
  exit /b 1
)

set "DIST=dist\alexa-broadcast-client"
if not exist "%DIST%\alexa-broadcast-client.exe" (
  echo Expected output not found: %DIST%\alexa-broadcast-client.exe
  pause
  popd
  exit /b 1
)

copy /Y config.json "%DIST%\config.json" >nul
if not exist "%DIST%\test" mkdir "%DIST%\test"
copy /Y "dist\send-test.exe" "%DIST%\test\send-test.exe" >nul

call :WriteLauncher "%DIST%\Run Alexa Broadcast Client.bat"
if not exist "%DIST%\Run Alexa Broadcast Client.bat" (
  echo Failed to create launcher: %DIST%\Run Alexa Broadcast Client.bat
  pause
  popd
  exit /b 1
)

(
echo @echo off
echo cd /d "%%~dp0"
echo echo Sending test broadcast to 127.0.0.1:47832 ...
echo test\send-test.exe %%*
echo echo.
echo pause
) > "%DIST%\test\run_test.bat"

(
echo @echo off
echo cd /d "%%~dp0"
echo echo Sending weather test to 127.0.0.1:47832 ...
echo test\send-test.exe --type weather --seconds 30
echo echo.
echo pause
) > "%DIST%\test\run_weather_test.bat"

(
echo @echo off
echo cd /d "%%~dp0"
echo echo Sending timer test to 127.0.0.1:47832 ...
echo test\send-test.exe --type timers --seconds 30
echo echo.
echo pause
) > "%DIST%\test\run_timers_test.bat"

(
echo @echo off
echo cd /d "%%~dp0"
echo echo Sending maximum-length scroll test to 127.0.0.1:47832 ...
echo test\send-test.exe --long %%*
echo echo.
echo pause
) > "%DIST%\test\run_long_test.bat"

echo.
echo Build complete.
echo Portable package: %CD%\%DIST%
echo.
echo Copy the entire "%DIST%" folder to your movie poster PC.
echo Run "Run Alexa Broadcast Client.bat" there - no Python or pip required.
echo.
pause
popd
exit /b 0

:PipFailed
echo Failed to install dependencies.
echo Try deleting the build environment and run this script again:
echo   rmdir /s /q "%BUILD_VENV%"
pause
popd
exit /b 1

:CheckPip
"%VENV_PY%" -m pip --version >nul 2>&1
if errorlevel 1 exit /b 1
"%VENV_PY%" -c "import PyInstaller" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:WriteLauncher
copy /Y "%~dp0packaging\Run Alexa Broadcast Client.bat" "%~1" >nul
if errorlevel 1 exit /b 1
exit /b 0
