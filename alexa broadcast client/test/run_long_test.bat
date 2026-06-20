@echo off
setlocal
cd /d "%~dp0\.."

set "PYTHON=%~dp0..\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo Creating virtual environment...
  py -3 -m venv .venv
  set "PYTHON=%~dp0..\.venv\Scripts\python.exe"
)

echo Sending maximum-length scroll test to 127.0.0.1:47832 ...
echo Make sure the broadcast client is running ^(run.bat^).
echo.

"%PYTHON%" test\send_test.py --long %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Test send failed with exit code %EXIT_CODE%.
  pause
  exit /b %EXIT_CODE%
)

echo Done. You should see the scrolling overlay on the display PC.
echo.
pause
