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
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173/"

echo AI Video Canvas started.
echo Open this if browser did not open:
echo http://127.0.0.1:4173/
echo.
pause

