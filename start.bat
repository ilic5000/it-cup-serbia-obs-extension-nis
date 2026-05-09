@echo off

:: ============================================================
::  CONFIGURABLE PORT  (change 3042 to any free port you like)
:: ============================================================
SET PORT=3042

title IT Cup OBS Extension
echo.
echo  ==========================================
echo   IT Cup OBS Extension
echo  ==========================================
echo.

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed or not in PATH.
    echo  Download it from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Install dependencies on first run
if not exist "%~dp0node_modules" (
    echo  Installing dependencies ^(first run, please wait^)...
    cd /d "%~dp0"
    npm install --silent
    if %errorlevel% neq 0 (
        echo  ERROR: npm install failed.
        pause
        exit /b 1
    )
    echo  Done.
    echo.
)

cd /d "%~dp0"

:: Open settings page in default browser after a short delay
start /min "" powershell -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://localhost:%PORT%/settings.html'"

echo  Starting server...
echo.
echo  Settings :  http://localhost:%PORT%/settings.html
echo  Overlay  :  http://localhost:%PORT%/overlay.html
echo.
echo  Press Ctrl+C to stop.
echo.

node server.js

pause
