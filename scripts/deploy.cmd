@echo off
rem 预览把本仓库同步到已安装的 DSH profile（加 -Apply 才真正复制）。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-profile.ps1" %*
pause
