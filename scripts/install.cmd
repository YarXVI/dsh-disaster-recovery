@echo off
rem 安装 dsh-disaster-recovery 到当前 DSH profile。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
