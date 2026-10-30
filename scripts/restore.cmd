@echo off
rem DSH 起不来时双击这个：默认把「最新快照」恢复回去（会先问一次）。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1" %*
echo.
pause
