@echo off
cd /d "%~dp0"
title MarsNav - self-test
if not exist MarsNav.exe (
  echo MarsNav.exe not found - run build_exe.bat first.
  pause
  exit /b 1
)
echo Starting the server exactly as the app does, loading it for about 3 minutes (map tiles, API, a route),
echo killing a raster worker and the server itself on purpose, and checking that everything recovers.
echo.
rem MarsNav.exe is a windowed program: /wait keeps this window until the test ends (its report prints here)
start "" /wait MarsNav.exe --selftest
echo.
echo Report: data_cache\selftest.txt
pause
