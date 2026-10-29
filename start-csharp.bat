@echo off
rem The C# app from this folder, on its data\, as start.bat runs the Node one. Builds it first,
rem which takes a minute the first time. Close the other app first: both use port 7272.
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
