@echo off
setlocal
cd /d "%~dp0"

if not exist logs mkdir logs

start "Mori Cafe" /min cmd /c "npm run local > logs\server.log 2>&1"

timeout /t 5 /nobreak > nul
start "" "http://localhost:5173/"
