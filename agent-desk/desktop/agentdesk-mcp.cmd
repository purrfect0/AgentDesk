@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0Agent Desk.exe" "%~dp0resources\app.asar\core\mcp.js" %*
exit /b %errorlevel%
