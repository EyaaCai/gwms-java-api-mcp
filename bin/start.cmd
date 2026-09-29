@echo off
setlocal
cd /d "%~dp0.."

if not exist "dist\index.js" (
  echo [gwms-mcp] dist\index.js not found. Run "npm install" then "npm run build" first. 1>&2
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [gwms-mcp] node not found. Install Node.js 18+ or point command to the node executable path in MCP config. 1>&2
  exit /b 1
)

node "dist\index.js" %*
