@echo off
title Zenload (Dev Mode)
echo ===================================================
echo             Starting Zenload (Dev Mode)
echo ===================================================
echo.
cd /d "%~dp0"
start "Zenload Backend" cmd /k "cd backend && bun run dev"
start "Zenload Frontend" cmd /k "cd frontend && bun run dev"
timeout /t 2 /nobreak >nul
start "" http://localhost:5173/zenload/
