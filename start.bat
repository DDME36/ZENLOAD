@echo off
title Zenload (Production)
echo ===================================================
echo           Starting Zenload (Production)
echo ===================================================
echo.
cd /d "%~dp0backend"
set NODE_ENV=production
timeout /t 1 /nobreak >nul
start "" http://localhost:3001/zenload/
bun run src/index.ts
pause
