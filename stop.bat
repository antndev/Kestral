@echo off
title Kestral Stop
echo Stoppe Kestral...
taskkill /F /IM kestral.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":1420" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Gestoppt. (App, Dev-Server und Port 1420 sind frei.)
timeout /t 2 >nul
