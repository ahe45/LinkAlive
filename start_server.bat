@echo off
setlocal
title LinkAlive Server

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 22 or later is required.
  goto :failed
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm 11 or later is required.
  goto :failed
)

if not exist ".env" (
  echo [ERROR] The .env file is missing.
  echo Copy .env.example to .env and configure the database and secrets first.
  goto :failed
)

powershell -NoProfile -Command "$ports = 3001, 4000, 4101, 4102; $used = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty LocalPort -Unique); if ($used.Count -eq 0) { exit 0 }; if ($used.Count -eq $ports.Count) { exit 2 }; exit 1"
set "port_status=%errorlevel%"

if "%port_status%"=="2" (
  echo LinkAlive is already running.
  echo Web: http://localhost:3001
  exit /b 0
)

if not "%port_status%"=="0" (
  echo [ERROR] One or more LinkAlive ports are already in use.
  echo Required ports: 3001, 4000, 4101, 4102
  goto :failed
)

echo [1/3] Installing dependencies...
call pnpm install --frozen-lockfile
if errorlevel 1 goto :failed

echo [2/3] Applying database migrations...
call pnpm db:deploy
if errorlevel 1 (
  echo [ERROR] Check that MySQL/MariaDB is running and DATABASE_URL is correct.
  goto :failed
)

echo [3/3] Starting LinkAlive...
echo Web: http://localhost:3001
echo Press Ctrl+C to stop all application processes.
call pnpm dev
exit /b %errorlevel%

:failed
echo.
echo LinkAlive could not be started.
pause
exit /b 1
