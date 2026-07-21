@echo off
title Kestral Dev
cd /d "%~dp0"
echo ============================================
echo   Starte Kestral (Dev)
echo   Dieses Fenster offen lassen.
echo   Zum Stoppen: Fenster schliessen oder Strg+C,
echo   oder spaeter stop.bat ausfuehren.
echo ============================================
echo.
call npm run tauri dev
echo.
echo Kestral wurde beendet.
pause
