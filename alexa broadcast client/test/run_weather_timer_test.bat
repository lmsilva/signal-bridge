@echo off
setlocal
cd /d "%~dp0"

set "PY=%~dp0..\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo Sending weather test (Home)...
"%PY%" "%~dp0send_test.py" --type weather --seconds 20
timeout /t 3 /nobreak >nul

echo Sending timer test...
"%PY%" "%~dp0send_test.py" --type timers --seconds 25
echo Done.
