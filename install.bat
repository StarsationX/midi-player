@echo off
setlocal enableextensions
cd /d "%~dp0"
title MIDI Player - first-time setup

echo ============================================================
echo MIDI Player - first-time setup
echo ============================================================
echo.
echo This script installs the Node.js packages and the Python
echo dependencies the app needs. Run it once after cloning, then
echo use start.bat (or "npm start") to launch.
echo.

REM ---------- Node check ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo         Install Node.js 18+ from https://nodejs.org and re-run this script.
  pause
  exit /b 1
)

REM ---------- Python check ----------
REM Probe each candidate by actually running --version. `where` alone is not
REM enough: the `py` launcher can be on PATH but point to an uninstalled
REM Python via stale registry entries ("Unable to create process using ...").
set "PY_CMD="
call :probe "py -3"
if not defined PY_CMD call :probe "py"
if not defined PY_CMD call :probe "python"
if not defined PY_CMD call :probe "python3"
if not defined PY_CMD (
  echo [ERROR] Couldn't launch a working Python.
  echo         Install Python 3.10+ from https://python.org
  echo         IMPORTANT: tick "Add python.exe to PATH" during install.
  echo.
  echo         If you previously had Python installed and removed it, the
  echo         "py" launcher may still be pointing at the deleted version.
  echo         Reinstalling Python (or running "py --list" to see what it
  echo         can find) will fix that.
  pause
  exit /b 1
)
echo Using Python: %PY_CMD%
%PY_CMD% --version
echo Using Node:
node --version
echo.

REM ---------- npm install ----------
echo [1/2] Installing Node packages (this can take a minute)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)
echo.

REM ---------- pip install ----------
echo [2/2] Installing Python packages...
%PY_CMD% -m pip install --upgrade pip
%PY_CMD% -m pip install -r python-engine\requirements.txt
if errorlevel 1 (
  echo [ERROR] pip install failed.
  echo         If you see "permission denied", try running as Administrator,
  echo         or run:    %PY_CMD% -m pip install --user -r python-engine\requirements.txt
  pause
  exit /b 1
)
echo.

echo ============================================================
echo Setup complete! Launch the app with start.bat or "npm start".
echo ============================================================
pause
exit /b 0

REM ---------- helper: probe a python command ----------
:probe
%~1 --version >nul 2>nul
if errorlevel 1 exit /b 0
set "PY_CMD=%~1"
exit /b 0
