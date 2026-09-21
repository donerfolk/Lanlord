@echo off
rem Release zip only: installs Lanlord as a Windows service using the node.exe next to it.
setlocal
cd /d "%~dp0"
title Install Lanlord

if not exist "node.exe" (
  echo Extract the whole zip first ^(right-click it, Extract All^), then run this file from the extracted folder.
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  rem Not elevated: ask Windows for admin rights and run this file again.
  set "SELF=%~f0"
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath $env:SELF"
  exit /b
)

echo Lanlord will run from this folder, and your shared files will live in its "shared" folder:
echo.
echo   %~dp0
echo.
echo To keep it somewhere else, close this window, move the folder, and run Install again.
echo.
pause

node.exe install-service.js
if errorlevel 1 (
  echo.
  echo Install failed. See the message above.
  pause
  exit /b 1
)

rem Give the service a moment to start, then open it. The Settings tab has the QR code for your phone.
timeout /t 4 /nobreak >nul
start "" http://localhost:8811
echo.
echo Done. Lanlord starts with Windows from now on.
echo In the page that just opened, go to Settings and scan the QR code with your phone.
pause
