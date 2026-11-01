@echo off
rem Starts ClaudeOS and opens it in your browser.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ClaudeOS needs Node.js 18 or newer: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing ClaudeOS the first time...
  call npm install --no-audit --no-fund
)
netstat -ano | findstr ":4747 " | findstr LISTENING >nul
if errorlevel 1 (
  start "ClaudeOS server" /min node server.mjs --open
) else (
  start "" http://localhost:4747
)
