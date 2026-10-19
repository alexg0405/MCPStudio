@echo off
rem AGstudio's MCP server over stdio, for apps that start MCP servers as programs (Claude Desktop), on Windows.
rem Finds Node, then runs agstudio-mcp.mjs next to this file, which relays to AGstudio's MCP endpoint.
rem Nothing may be printed to the screen here: the app reads this program's output as protocol messages.
setlocal

where node >nul 2>nul
if not errorlevel 1 goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%" & goto run
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%" & goto run
echo agstudio-mcp: Node.js was not found. Install Node 22 from https://nodejs.org. 1>&2
exit /b 1

:run
node "%~dp0agstudio-mcp.mjs" %*
exit /b %ERRORLEVEL%
