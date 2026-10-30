@echo off
rem 手动做一次快照（不依赖 DSH）。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1" -Backup
if errorlevel 1 pause
else pause
