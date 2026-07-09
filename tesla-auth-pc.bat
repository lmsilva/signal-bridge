@echo off
setlocal EnableExtensions
pushd "%~dp0"

echo Tesla OAuth (localhost callback - run on this PC, not the NAS)
echo Working directory: %CD%
echo.

if not exist .env (
  echo ERROR: .env not found in %CD%
  echo Copy .env.example to .env and set TESLA_CLIENT_ID / TESLA_CLIENT_SECRET.
  popd
  exit /b 1
)

call npm run tesla-auth
set "EXIT_CODE=%ERRORLEVEL%"

if exist "data\tesla-session.json" (
  set "EXIT_CODE=0"
)

echo.
if "%EXIT_CODE%"=="0" (
  echo Done. Session saved to data\tesla-session.json
  echo On the NAS run: ./tesla-status.sh and ./recreate.sh
  echo Pair virtual key on phone: see tesla-status.sh output
) else (
  echo Tesla auth failed with exit code %EXIT_CODE%
)

popd
pause
exit /b %EXIT_CODE%
