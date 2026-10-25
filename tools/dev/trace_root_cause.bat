@echo off
rem Memory and process diagnostics for the desktop server (see tools\trace_root_cause.py); "temp" as argument checks temp files only
cd /d "%~dp0..\.."
title MarsNav - root-cause trace
".buildvenv\Scripts\python.exe" tools\trace_root_cause.py %*
echo.
echo Trace finished. Results: data_cache\trace_root_cause.txt
