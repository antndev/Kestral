@echo off
title Kestral Stop
echo Stopping Kestral...
taskkill /F /IM kestral.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":1420" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Stopped. (App, dev server and port 1420 are free.)
timeout /t 2 >nul
