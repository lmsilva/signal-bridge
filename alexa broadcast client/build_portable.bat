@echo off
setlocal
cd /d "%~dp0"

set "PYTHON="
where py >nul 2>&1 && set "PYTHON=py -3"
if not defined PYTHON where python >nul 2>&1 && set "PYTHON=python"
if not defined PYTHON if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYTHON (
  echo Python not found. Install Python 3.10+ from https://www.python.org/downloads/
  pause
  exit /b 1
)

if not exist .venv (
  echo Creating build virtual environment...
  %PYTHON% -m venv .venv
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt pyinstaller

echo.
echo Building portable Alexa Broadcast Client...
pyinstaller --noconfirm alexa-broadcast-client.spec
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

set "DIST=dist\alexa-broadcast-client"
if not exist "%DIST%" (
  echo Expected output folder not found: %DIST%
  pause
  exit /b 1
)

copy /Y config.json "%DIST%\config.json" >nul
if not exist "%DIST%\test" mkdir "%DIST%\test"
copy /Y dist\send-test.exe "%DIST%\test\send-test.exe" >nul

copy /Y packaging\Run Alexa Broadcast Client.bat "%DIST%\Run Alexa Broadcast Client.bat" >nul

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
