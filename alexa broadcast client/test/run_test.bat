@echo off
setlocal
cd /d "%~dp0\.."

set "PYTHON=%~dp0..\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo Creating virtual environment...
  py -3 -m venv .venv
  if errorlevel 1 (
    echo Failed to create virtual environment. Install Python 3 from https://www.python.org/downloads/
    pause
    exit /b 1
  )
  set "PYTHON=%~dp0..\.venv\Scripts\python.exe"
)

echo Sending test broadcast to 127.0.0.1:47832 ...
echo Make sure the broadcast client is running ^(run.bat^).
echo.

"%PYTHON%" test\send_test.py %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Test send failed with exit code %EXIT_CODE%.
  pause
  exit /b %EXIT_CODE%
)

echo Done. You should see the overlay on the display PC.
echo If nothing appeared, start the client with run.bat and try again.
echo.
pause
