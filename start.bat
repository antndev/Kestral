@echo off
title Kestral Dev
cd /d "%~dp0"
echo ============================================
echo   Starting Kestral (dev)
echo   Keep this window open.
echo   To stop: close the window or press Ctrl+C,
echo   or run stop.bat later.
echo ============================================
echo.
call npm run tauri dev
echo.
echo Kestral stopped.
pause
