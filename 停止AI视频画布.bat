@echo off
setlocal

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4173" ^| findstr "LISTENING"') do (
  taskkill /PID %%P /T /F >nul 2>nul
)

echo AI Video Canvas stopped.
exit /b 0

