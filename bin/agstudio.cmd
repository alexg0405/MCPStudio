@echo off
rem One command to start AGstudio on Windows: agstudio (double-click it, or run it from a terminal).
rem It only finds Node and runs scripts\agstudio.mjs, where the real work is. macOS and Linux use bin/agstudio.
rem   agstudio          the dev server on http://localhost:5390, opened in your browser
rem   agstudio --app    the production build on http://localhost:5391, opened as the installed app
setlocal

where node >nul 2>nul
if not errorlevel 1 goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%" & goto run
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%" & goto run
echo agstudio: Node.js was not found. Install Node 22 or newer from https://nodejs.org ^(the LTS installer^), then open a new terminal and try again.
if "%~1"=="" pause
exit /b 1

:run
node "%~dp0..\scripts\agstudio.mjs" %*
set "AGSTUDIO_EXIT=%ERRORLEVEL%"
rem Started by a double-click, the window would vanish with the message; keep it until a key is pressed.
if not "%AGSTUDIO_EXIT%"=="0" if "%~1"=="" pause
exit /b %AGSTUDIO_EXIT%
