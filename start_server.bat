@echo off
setlocal EnableExtensions EnableDelayedExpansion
title LinkAlive Server

cd /d "%~dp0"

set "REQUIRED_NODE_MAJOR=22"
set "REQUIRED_PNPM_VERSION=11.19.0"

call :check_application_ports
if "!APP_PORT_STATUS!"=="2" (
  echo LinkAlive is already running.
  echo Web: http://localhost:3001
  exit /b 0
)
if not "!APP_PORT_STATUS!"=="0" (
  echo [ERROR] One or more LinkAlive ports are already in use.
  echo Required ports: 3001, 4000, 4101, 4102
  goto :failed
)

echo [1/6] Checking Node.js...
call :ensure_node
if errorlevel 1 goto :failed

echo [2/6] Checking pnpm...
call :ensure_pnpm
if errorlevel 1 goto :failed

echo [3/6] Preparing local configuration...
call :ensure_environment
if errorlevel 1 goto :failed

echo [4/6] Installing project dependencies...
call pnpm install --frozen-lockfile
if errorlevel 1 goto :failed

echo [5/6] Checking MySQL/MariaDB and Redis...
call :ensure_infrastructure
if errorlevel 1 goto :failed

echo [6/6] Applying database migrations...
call pnpm db:deploy
if errorlevel 1 (
  echo [ERROR] Database migration failed. Check DATABASE_URL in .env.
  goto :failed
)

echo.
echo Starting LinkAlive...
echo Web: http://localhost:3001
echo Press Ctrl+C to stop all application processes.
call pnpm dev
exit /b !errorlevel!

:check_application_ports
powershell -NoProfile -Command "$ports = 3001, 4000, 4101, 4102; $used = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty LocalPort -Unique); if ($used.Count -eq 0) { exit 0 }; if ($used.Count -eq $ports.Count) { exit 2 }; exit 1"
set "APP_PORT_STATUS=!errorlevel!"
exit /b 0

:refresh_path
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\Docker\Docker\resources\bin;%PATH%"
exit /b 0

:require_winget
where winget.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Windows Package Manager is required for automatic installation.
  echo Install or update "App Installer" from Microsoft Store, then run this file again.
  exit /b 1
)
exit /b 0

:ensure_node
call :refresh_path
where node.exe >nul 2>&1
if not errorlevel 1 (
  node -e "process.exit(Number(process.versions.node.split('.')[0]) >= %REQUIRED_NODE_MAJOR% ? 0 : 1)"
  if not errorlevel 1 (
    for /f "delims=" %%V in ('node --version') do echo Node.js %%V is ready.
    exit /b 0
  )
  echo Node.js %REQUIRED_NODE_MAJOR% or later is required. Updating Node.js...
) else (
  echo Node.js was not found. Installing the current LTS release...
)

call :require_winget
if errorlevel 1 exit /b 1
winget install --exact --id OpenJS.NodeJS.LTS --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo [ERROR] Node.js installation failed.
  exit /b 1
)

call :refresh_path
where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was installed but is not available yet. Restart Windows and try again.
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= %REQUIRED_NODE_MAJOR% ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] The installed Node.js version is too old.
  exit /b 1
)
exit /b 0

:ensure_pnpm
call :refresh_path
set "PNPM_MAJOR="
where pnpm.cmd >nul 2>&1
if not errorlevel 1 (
  for /f "tokens=1 delims=." %%V in ('pnpm --version 2^>nul') do set "PNPM_MAJOR=%%V"
)
if defined PNPM_MAJOR if !PNPM_MAJOR! GEQ 11 (
  for /f "delims=" %%V in ('pnpm --version') do echo pnpm %%V is ready.
  exit /b 0
)

echo Installing pnpm %REQUIRED_PNPM_VERSION%...
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm is unavailable even though Node.js is installed.
  exit /b 1
)
call npm.cmd install --global pnpm@%REQUIRED_PNPM_VERSION%
if errorlevel 1 (
  echo [ERROR] pnpm installation failed.
  exit /b 1
)
call :refresh_path
where pnpm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm was installed but is not available yet. Open a new terminal and try again.
  exit /b 1
)
exit /b 0

:ensure_environment
if not exist ".env.example" (
  echo [ERROR] .env.example is missing. Run this file from a complete LinkAlive checkout.
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  node -e "const fs=require('node:fs');const crypto=require('node:crypto');let value=fs.readFileSync('.env','utf8');value=value.replace(/^ADMIN_PASSWORD=.*$/m,'ADMIN_PASSWORD=1234').replace(/^AUTH_SECRET=.*$/m,'AUTH_SECRET='+crypto.randomBytes(48).toString('base64url')).replace(/^ENCRYPTION_KEY=.*$/m,'ENCRYPTION_KEY='+crypto.randomBytes(32).toString('base64'));fs.writeFileSync('.env',value,'utf8');"
  if errorlevel 1 (
    del /q ".env" >nul 2>&1
    echo [ERROR] Could not create .env.
    exit /b 1
  )
  echo Created .env with admin account admin / 1234 and new local secrets.
) else (
  echo Existing .env will be preserved.
)

node -e "const value=require('node:fs').readFileSync('.env','utf8');process.exit(value.includes('change-this-before-running')||value.includes('replace-with-at-least-32-random-characters')||value.includes('replace-with-a-base64-encoded-32-byte-key')?1:0)"
if errorlevel 1 (
  echo [ERROR] .env still contains example credentials. Update it or remove it to generate a new local file.
  exit /b 1
)
exit /b 0

:port_open
powershell -NoProfile -Command "$client = New-Object Net.Sockets.TcpClient; try { $result = $client.BeginConnect('127.0.0.1', %~1, $null, $null); if (-not $result.AsyncWaitHandle.WaitOne(1500)) { exit 1 }; $client.EndConnect($result); exit 0 } catch { exit 1 } finally { $client.Dispose() }"
exit /b !errorlevel!

:ensure_infrastructure
set "INFRA_SERVICES="
call :port_open 3306
if errorlevel 1 set "INFRA_SERVICES=!INFRA_SERVICES! mysql"
call :port_open 6379
if errorlevel 1 set "INFRA_SERVICES=!INFRA_SERVICES! redis"

if not defined INFRA_SERVICES (
  echo MySQL/MariaDB and Redis are already reachable.
  exit /b 0
)

echo Missing local services:!INFRA_SERVICES!
call :ensure_docker
if errorlevel 1 exit /b 1

docker compose -f infra/compose.yaml up -d --wait --wait-timeout 120 !INFRA_SERVICES!
if errorlevel 1 (
  echo [ERROR] Could not start the local infrastructure containers.
  exit /b 1
)

call :wait_for_port 3306 90
if errorlevel 1 (
  echo [ERROR] MySQL/MariaDB did not become ready on port 3306.
  exit /b 1
)
call :wait_for_port 6379 60
if errorlevel 1 (
  echo [ERROR] Redis did not become ready on port 6379.
  exit /b 1
)
echo MySQL/MariaDB and Redis are ready.
exit /b 0

:ensure_docker
call :refresh_path
where docker.exe >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop was not found. Installing it...
  call :require_winget
  if errorlevel 1 exit /b 1
  winget install --exact --id Docker.DockerDesktop --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] Docker Desktop installation failed.
    exit /b 1
  )
  call :refresh_path
)

where docker.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker Desktop was installed but is not available yet. Restart Windows and try again.
  exit /b 1
)

docker info >nul 2>&1
if not errorlevel 1 exit /b 0

if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  echo Starting Docker Desktop...
  powershell -NoProfile -Command "Start-Process -FilePath '%ProgramFiles%\Docker\Docker\Docker Desktop.exe' -WindowStyle Hidden"
)

echo Waiting for Docker Desktop to become ready...
for /l %%I in (1,1,90) do (
  docker info >nul 2>&1
  if not errorlevel 1 exit /b 0
  timeout /t 2 /nobreak >nul
)

echo [ERROR] Docker Desktop did not become ready.
echo Complete Docker Desktop first-run setup or restart Windows, then run this file again.
exit /b 1

:wait_for_port
set "WAIT_PORT=%~1"
set "WAIT_SECONDS=%~2"
for /l %%I in (1,1,!WAIT_SECONDS!) do (
  call :port_open !WAIT_PORT!
  if not errorlevel 1 exit /b 0
  timeout /t 1 /nobreak >nul
)
exit /b 1

:failed
echo.
echo LinkAlive could not be started.
pause
exit /b 1
