@echo off
cd /d "%~dp0"
node src\main.ts
if errorlevel 1 pause
