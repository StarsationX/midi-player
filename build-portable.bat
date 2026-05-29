@echo off
setlocal enableextensions
cd /d "%~dp0"
title MIDI Player - build portable engine

echo ============================================================
echo Building portable Python sidecar (PyInstaller)
echo ============================================================
echo This bundles ipc_main.py + dependencies into a single .exe
echo so end users don't need Python installed.
echo Takes ~1 minute.
echo.

REM Find a working python (same probe logic as install.bat).
set "PY_CMD="
call :probe "py -3"
if not defined PY_CMD call :probe "py"
if not defined PY_CMD call :probe "python"
if not defined PY_CMD call :probe "python3"
if not defined PY_CMD (
  echo [ERROR] Couldn't launch a working Python.
  pause
  exit /b 1
)
echo Using Python: %PY_CMD%
%PY_CMD% --version
echo.

echo [1/3] Ensuring pyinstaller is installed...
%PY_CMD% -m pip install --quiet --upgrade pyinstaller
if errorlevel 1 (
  echo [ERROR] Failed to install pyinstaller.
  pause
  exit /b 1
)

echo [2/3] Running PyInstaller...
%PY_CMD% -m PyInstaller --noconfirm --clean ^
  --distpath build\pyinstaller\dist ^
  --workpath build\pyinstaller\work ^
  python-engine\ipc_main.spec
if errorlevel 1 (
  echo [ERROR] PyInstaller build failed.
  pause
  exit /b 1
)

if not exist build\pyinstaller\dist\ipc_main.exe (
  echo [ERROR] Expected build\pyinstaller\dist\ipc_main.exe but it wasn't produced.
  pause
  exit /b 1
)

echo [3/3] Copying ipc_main.exe into python-engine\ (main.js prefers it)...
copy /y build\pyinstaller\dist\ipc_main.exe python-engine\ipc_main.exe >nul

echo.
echo ============================================================
echo Done. Sidecar built:
echo   python-engine\ipc_main.exe
for %%I in (python-engine\ipc_main.exe) do echo   size: %%~zI bytes
echo.
echo Next steps:
echo   - npm start              run the app with the bundled sidecar
echo   - npm run build:portable build a single portable .exe (NSIS-free)
echo ============================================================
pause
exit /b 0

:probe
%~1 --version >nul 2>nul
if errorlevel 1 exit /b 0
set "PY_CMD=%~1"
exit /b 0
