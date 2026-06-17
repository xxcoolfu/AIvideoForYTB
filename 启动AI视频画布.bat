@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found.
  echo Please install Node.js LTS first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

call "%~dp0停止AI视频画布.bat" >nul 2>nul

start "AI Video Canvas" /min cmd /c "\"%~dp0run-ai-video-canvas.bat\""
set READY=
for /l %%I in (1,1,30) do (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 (
    set READY=1
    goto :service_ready
  )
  timeout /t 1 /nobreak >nul
)

:service_ready
if not defined READY (
  echo AI Video Canvas service did not become ready. Browser was not opened to avoid a blank page.
  echo Please check:
  echo %~dp0server.log
  echo.
  if exist "%~dp0server.log" type "%~dp0server.log"
  echo.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:4173/"

echo AI Video Canvas started.
echo Open this if browser did not open:
echo http://127.0.0.1:4173/
echo.
pause
