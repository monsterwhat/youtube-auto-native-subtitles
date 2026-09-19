@echo off
rem Double-click friendly launcher for build.ps1.
rem Enables script execution for this process only, then builds.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
if errorlevel 1 pause
