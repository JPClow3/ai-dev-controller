@echo off
TITLE Stop AI Dev Controller
echo Stopping AI Dev Controller...
echo.
cd /d "%~dp0"

:: This uninstalls the supervisor scheduled task and stops any running controller processes.
call pnpm supervisor:uninstall

echo.
echo =======================================================
echo AI Dev Controller has been stopped and uninstalled.
echo =======================================================
echo.
pause
