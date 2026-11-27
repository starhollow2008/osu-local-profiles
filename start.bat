@echo off
rem The app from this checkout, on its data folder. Builds it first, which takes a minute
rem the first time.
setlocal
cd /d "%~dp0"
where dotnet >/dev/null 2>/dev/null || (
  echo.
  echo  The .NET 10 SDK is needed to run the app from source:
  echo  https://dotnet.microsoft.com/download
  echo.
  pause
  exit /b 1
)
rem Restart on the page exits with 75, and this starts the app again, built from the checkout as it
rem is then (Instance.LauncherEnv and Updater.RestartExitCode; issue #43).
set OSU_LOCAL_PROFILES_LAUNCHER=restarts
:run
dotnet run --project dotnet\App -c Release
if %errorlevel% equ 75 (
  echo.
  echo   Restarting.
  echo.
  goto run
)
if errorlevel 1 pause
