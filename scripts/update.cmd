@echo off
rem Fangio updater for Windows: double-click this file inside the installed extension folder.
rem It runs update.ps1 (same folder) with Windows PowerShell; see that file for details.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
set "rc=%ERRORLEVEL%"
echo.
pause
exit /b %rc%
