@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
call npm.cmd ci
if errorlevel 1 (
  pause
  exit /b 1
)
call npm.cmd run deploy
pause
