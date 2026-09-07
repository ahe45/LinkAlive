@echo off
setlocal EnableExtensions EnableDelayedExpansion
title LinkAlive Server

cd /d "%~dp0"

set "REQUIRED_NODE_MAJOR=22"
set "REQUIRED_PNPM_VERSION=11.19.0"
set "REDIS_WINGET_ID=taizod1024.redis-windows-fork"

call :configure_network_access

call :check_application_ports
if "!APP_PORT_STATUS!"=="2" (
  echo LinkAlive is already running.
  echo Web: !LINKALIVE_WEB_URL!
  echo API readiness: !LINKALIVE_WEB_URL!/linkalive-api/health/ready
  exit /b 0
)
if not "!APP_PORT_STATUS!"=="0" (
  echo [ERROR] One or more LinkAlive ports are already in use.
  echo Required ports: 3001, 4000, 4101, 4102
  goto :failed
)

echo [1/7] Checking Node.js...
call :ensure_node
if errorlevel 1 goto :failed

echo [2/7] Checking pnpm...
call :ensure_pnpm
if errorlevel 1 goto :failed

echo [3/7] Preparing local configuration...
call :ensure_environment
if errorlevel 1 goto :failed

echo [4/7] Installing project dependencies...
call pnpm install --frozen-lockfile
if errorlevel 1 goto :failed

echo [5/7] Checking MySQL/MariaDB and Redis...
call :ensure_infrastructure
if errorlevel 1 goto :failed

echo [6/7] Applying database migrations...
call pnpm db:deploy
if errorlevel 1 (
  echo [ERROR] Database migration failed. Check DATABASE_URL in .env.
  goto :failed
)

call pnpm db:bootstrap:admin
if errorlevel 1 (
  echo [ERROR] Initial administrator account setup failed.
  goto :failed
)

echo [7/7] Building the production application...
call pnpm build
if errorlevel 1 (
  echo [ERROR] Application build failed.
  goto :failed
)

echo.
echo Starting LinkAlive...
echo Web: !LINKALIVE_WEB_URL!
echo API readiness: !LINKALIVE_WEB_URL!/linkalive-api/health/ready
if not "!LINKALIVE_ACCESS_HOST!"=="localhost" (
  echo LAN access requires Windows Firewall inbound TCP port 3001.
)
echo Press Ctrl+C to stop all application processes.
call pnpm start
exit /b !errorlevel!

:configure_network_access
set "LINKALIVE_ACCESS_HOST="
if defined LINKALIVE_HOST set "LINKALIVE_ACCESS_HOST=!LINKALIVE_HOST!"

if not defined LINKALIVE_ACCESS_HOST (
  for /f "delims=" %%I in ('powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\detect-network-address.ps1"') do set "LINKALIVE_ACCESS_HOST=%%I"
)

if not defined LINKALIVE_ACCESS_HOST set "LINKALIVE_ACCESS_HOST=localhost"
set "LINKALIVE_WEB_URL=http://!LINKALIVE_ACCESS_HOST!:3001"
set "WEB_ORIGIN=!LINKALIVE_WEB_URL!"
set "NEXT_PUBLIC_API_BASE_URL=/linkalive-api"
set "INTERNAL_API_BASE_URL=http://127.0.0.1:4000"
set "APP_BASE_URL=!LINKALIVE_WEB_URL!"
exit /b 0

:check_application_ports
powershell -NoProfile -Command "$ports = 3001, 4000, 4101, 4102; $used = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty LocalPort -Unique); if ($used.Count -eq 0) { exit 0 }; if ($used.Count -eq $ports.Count) { exit 2 }; exit 1"
set "APP_PORT_STATUS=!errorlevel!"
exit /b 0

:refresh_path
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
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
  node -e "const fs=require('node:fs');const crypto=require('node:crypto');let value=fs.readFileSync('.env','utf8');value=value.replace(/^ADMIN_PASSWORD=.*$/m,'ADMIN_PASSWORD=control1@').replace(/^AUTH_SECRET=.*$/m,'AUTH_SECRET='+crypto.randomBytes(48).toString('base64url')).replace(/^ENCRYPTION_KEY=.*$/m,'ENCRYPTION_KEY='+crypto.randomBytes(32).toString('base64'));fs.writeFileSync('.env',value,'utf8');"
  if errorlevel 1 (
    del /q ".env" >nul 2>&1
    echo [ERROR] Could not create .env.
    exit /b 1
  )
  echo Created .env with initial admin account admin / control1@ and new local secrets.
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
call :ensure_redis
if errorlevel 1 exit /b 1

call :port_open 3306
if not errorlevel 1 (
  echo MySQL/MariaDB and Redis are already reachable.
  exit /b 0
)

echo [ERROR] MySQL/MariaDB is not reachable on port 3306.
echo Start MySQL/MariaDB and check DATABASE_URL in .env, then run this file again.
exit /b 1

:ensure_redis
call :port_open 6379
if not errorlevel 1 (
  echo Redis is already reachable.
  exit /b 0
)

call :find_redis_server
if errorlevel 1 (
  echo Redis was not found. Installing the Windows Redis runtime...
  call :require_winget
  if errorlevel 1 exit /b 1
  winget install --exact --id %REDIS_WINGET_ID% --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] Redis installation failed.
    exit /b 1
  )
  call :find_redis_server
  if errorlevel 1 (
    echo [ERROR] Redis was installed but redis-server.exe could not be found.
    exit /b 1
  )
)

set "REDIS_DATA_DIR=%LOCALAPPDATA%\LinkAlive\redis"
if not exist "!REDIS_DATA_DIR!" mkdir "!REDIS_DATA_DIR!"
if not exist "!REDIS_DATA_DIR!" (
  echo [ERROR] Could not create the local Redis data folder.
  exit /b 1
)

echo Starting local Redis...
powershell -NoProfile -Command "Start-Process -FilePath '!REDIS_SERVER!' -ArgumentList @('--bind','127.0.0.1','--port','6379','--protected-mode','yes','--appendonly','yes','--dir','!REDIS_DATA_DIR!') -WindowStyle Hidden"
if errorlevel 1 (
  echo [ERROR] Redis could not be started.
  exit /b 1
)

call :wait_for_port 6379 30
if errorlevel 1 (
  echo [ERROR] Redis did not become ready on port 6379.
  exit /b 1
)
echo Redis is ready.
exit /b 0

:find_redis_server
set "REDIS_SERVER="
for /f "delims=" %%R in ('where redis-server.exe 2^>nul') do if not defined REDIS_SERVER set "REDIS_SERVER=%%R"
if defined REDIS_SERVER exit /b 0

for /f "delims=" %%R in ('powershell -NoProfile -Command "$root = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'; if (Test-Path -LiteralPath $root) { foreach ($directory in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) { if ($directory.Name -like 'taizod1024.redis-windows-fork*') { $candidates = @(Get-ChildItem -LiteralPath $directory.FullName -Filter 'redis-server.exe' -File -Recurse -ErrorAction SilentlyContinue); if ($candidates.Count -gt 0) { $candidates[0].FullName; break } } } }"') do set "REDIS_SERVER=%%R"
if defined REDIS_SERVER exit /b 0
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
