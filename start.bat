@echo off
rem The app from this checkout, on its data folder. Builds it first, which takes a minute
rem the first time.
cd /d "%~dp0"
where dotnet >nul 2>nul || (
  echo.
  echo  The .NET 10 SDK is needed to run the app from source:
  echo  https://dotnet.microsoft.com/download
  echo.
  pause
  exit /b 1
)
dotnet run --project dotnet\App -c Release
if errorlevel 1 pause
