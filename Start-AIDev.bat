@echo off
TITLE Start AI Dev Controller
echo Starting AI Dev Controller...
echo.
cd /d "%~dp0"

:: This calls the existing supervisor install script which registers a scheduled task
:: to run at logon, and immediately starts it. The supervisor will launch the 
:: controller and ensure Orca is running in the background.
call pnpm supervisor:install

echo.
echo =======================================================
echo AI Dev Controller has been started in the background!
echo It will also automatically start when you log on.
echo =======================================================
echo.
pause
