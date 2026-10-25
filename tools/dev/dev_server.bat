@echo off
rem Development server: runs the launcher from source (no exe rebuild needed). Log: data_cache\dev_server_N.log (newest in dev_server_last.txt)
cd /d "%~dp0..\.."
if not exist data_cache mkdir data_cache
set LOG=data_cache\dev_server_%RANDOM%.log
echo %LOG%> data_cache\dev_server_last.txt
".buildvenv\Scripts\python.exe" -u launcher\martian_map.py --no-browser --headless --dev > "%LOG%" 2>&1
echo exit %ERRORLEVEL%>> data_cache\dev_server_last.txt
