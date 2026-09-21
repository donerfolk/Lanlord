@echo off
rem Release zip only: removes the Lanlord service. The folder and your shared files stay.
setlocal
cd /d "%~dp0"
title Uninstall Lanlord

net session >nul 2>&1
if errorlevel 1 (
  set "SELF=%~f0"
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath $env:SELF"
  exit /b
)

node.exe uninstall-service.js
echo.
echo Lanlord no longer runs. Your files are still in the "shared" folder; delete this folder to remove everything.
pause
