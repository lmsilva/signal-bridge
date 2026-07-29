@echo off
setlocal
cd /d "%~dp0\.."

REM Runtime (+ test) deps: pip install -r requirements-test.txt
set "PYTHON="
if exist ".venv\Scripts\python.exe" set "PYTHON=.venv\Scripts\python.exe"
if not defined PYTHON where py >nul 2>&1 && set "PYTHON=py -3"
if not defined PYTHON where python >nul 2>&1 && set "PYTHON=python"

if not defined PYTHON (
  echo Python not found.
  exit /b 1
)

"%PYTHON%" -m unittest discover -s test -p "test_*.py" -v
