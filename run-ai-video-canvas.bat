@echo off
setlocal
cd /d "%~dp0"
node server.js > server.log 2>&1
