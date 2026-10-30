@echo off
rem 列出快照。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1" -List
echo.
pause
