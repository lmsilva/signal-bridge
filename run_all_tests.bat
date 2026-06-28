@echo off
setlocal EnableExtensions

pushd "%~dp0" 2>nul
if errorlevel 1 (
  echo ERROR: Cannot use repo path as working directory: %~dp0
  echo Run from a mapped drive or use: pushd %~dp0
  exit /b 1
)

set "FAILED=0"

echo === Bridge tests (npm test) ===
call npm test
if errorlevel 1 set "FAILED=1"

echo.
echo === Client tests (unittest) ===
if exist "alexa broadcast client\.venv\Scripts\python.exe" (
  pushd "alexa broadcast client"
  call .venv\Scripts\python.exe -m unittest discover -s test -p "test_*.py" -v
  if errorlevel 1 set "FAILED=1"
  popd
  goto Done
)

where py >nul 2>&1
if not errorlevel 1 (
  pushd "alexa broadcast client"
  py -3 -m unittest discover -s test -p "test_*.py" -v
  if errorlevel 1 set "FAILED=1"
  popd
  goto Done
)

where python >nul 2>&1
if not errorlevel 1 (
  pushd "alexa broadcast client"
  python -m unittest discover -s test -p "test_*.py" -v
  if errorlevel 1 set "FAILED=1"
  popd
  goto Done
)

echo ERROR: Python not found for client tests.
set "FAILED=1"

:Done
popd
if "%FAILED%"=="1" (
  echo.
  echo TEST SUITE FAILED
  exit /b 1
)

echo.
echo ALL TESTS PASSED
exit /b 0
