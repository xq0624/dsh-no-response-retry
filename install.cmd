@echo off
REM Double-click: install dsh-no-response-retry into this machine's dsh "desktop" profile
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
