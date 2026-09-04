@echo off
setlocal EnableExtensions EnableDelayedExpansion
title LinkAlive Update

cd /d "%~dp0"

set "__LOG_DIR=%~dp0log"
set "__UPDATE_LOG=%__LOG_DIR%\update-server.log"
set "__HAS_LOCAL_CHANGES=0"
set "__BRANCH="

if not exist "%__LOG_DIR%" mkdir "%__LOG_DIR%"
echo LinkAlive update started: %DATE% %TIME%> "%__UPDATE_LOG%"

echo Updating LinkAlive from GitHub.
echo.

where git.exe >nul 2>&1
if errorlevel 1 (
  echo git.exe was not found.>> "%__UPDATE_LOG%"
  echo [ERROR] Git for Windows was not found.
  echo Install Git for Windows, then run this file again.
  goto :failed
)

if not exist "%~dp0.git" (
  echo This folder is not a Git clone.>> "%__UPDATE_LOG%"
  echo [ERROR] This folder is not a Git clone.
  echo Use this update file only inside a LinkAlive folder created with git clone.
  goto :failed
)

powershell -NoProfile -Command "$ports = 3001, 4000, 4101, 4102; $used = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }); if ($used.Count -gt 0) { exit 1 }; exit 0"
if errorlevel 1 (
  echo LinkAlive application ports are in use.>> "%__UPDATE_LOG%"
  echo [ERROR] LinkAlive is currently running.
  echo Stop the server with Ctrl+C, then run this update file again.
  goto :failed
)

for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "__BRANCH=%%B"
if not defined __BRANCH (
  echo Git is in detached HEAD state.>> "%__UPDATE_LOG%"
  echo [ERROR] The current Git branch could not be determined.
  echo Switch to the main branch, then run this file again.
  goto :failed
)

for /f "delims=" %%S in ('git status --porcelain 2^>nul') do set "__HAS_LOCAL_CHANGES=1"
if "!__HAS_LOCAL_CHANGES!"=="1" (
  echo Local changes were found.>> "%__UPDATE_LOG%"
  echo [ERROR] Local changes were found. The update was stopped to protect them.
  echo.
  git status --short
  echo.
  echo Commit, stash, or remove the changes before running this file again.
  goto :failed
)

where pnpm.cmd >nul 2>&1
if errorlevel 1 (
  echo pnpm was not found.>> "%__UPDATE_LOG%"
  echo [ERROR] pnpm was not found.
  echo Run start_server.bat once to install all required programs, then try again.
  goto :failed
)

echo Current branch: !__BRANCH!
echo [1/4] Fetching the latest version...
git fetch origin >> "%__UPDATE_LOG%" 2>>&1
if errorlevel 1 goto :update_failed

echo [2/4] Applying the latest version...
git pull --ff-only origin "!__BRANCH!" >> "%__UPDATE_LOG%" 2>>&1
if errorlevel 1 goto :update_failed

echo [3/4] Installing project dependencies...
call pnpm install --frozen-lockfile >> "%__UPDATE_LOG%" 2>>&1
if errorlevel 1 goto :update_failed

echo [4/4] Applying database migrations...
call pnpm db:deploy >> "%__UPDATE_LOG%" 2>>&1
if errorlevel 1 goto :update_failed

echo LinkAlive update completed: %DATE% %TIME%>> "%__UPDATE_LOG%"
echo.
echo LinkAlive update completed.
echo Start the server again with:
echo   start_server.bat
echo.
echo Update log:
echo   %__UPDATE_LOG%
pause
exit /b 0

:update_failed
echo LinkAlive update failed: %DATE% %TIME%>> "%__UPDATE_LOG%"
echo.
echo [ERROR] LinkAlive update failed.
goto :failed

:failed
echo.
echo Update log:
echo   %__UPDATE_LOG%
pause
exit /b 1
