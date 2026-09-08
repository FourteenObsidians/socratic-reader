@echo off
title Socratic Reader
cd /d "%~dp0"

REM ---- 0) Already running? Just open browser ----
curl -s -o nul -m 2 http://127.0.0.1:3777/api/status
if %errorlevel%==0 (
  echo Server already running. Opening browser...
  start "" "http://127.0.0.1:3777"
  goto :END
)

REM ---- 1) Try Windows Node.js ----
where node >nul 2>nul
if %errorlevel%==0 (
  echo Starting server with Windows Node...
  start "SocraticReader-server" /min cmd /c "node server.js"
  goto :BROWSER
)

REM ---- 2) Fallback: WSL Node ----
where wsl >nul 2>nul
if %errorlevel%==0 (
  echo Starting server with WSL Node...
  start "SocraticReader-server" /min wsl --cd "%~dp0" -e bash -c "node server.js"
  goto :BROWSER
)

echo ==================================================
echo  Node.js not found. Install the LTS from
echo  https://nodejs.org  then double-click this again.
echo ==================================================
pause
exit /b 1

:BROWSER
echo Waiting for server...
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:3777"
echo.
echo   =========================================
echo    Socratic Reader  --^>  http://127.0.0.1:3777
echo    To STOP: close the minimized window
echo    titled "SocraticReader-server".
echo   =========================================
echo.

:END
pause
