@echo off
rem The end-to-end server self-test, run from the Python source instead of MarsNav.exe
cd /d "%~dp0..\.."
title MarsNav - self-test (from source)
".buildvenv\Scripts\python.exe" -u launcher\martian_map.py --selftest
echo.
echo Self-test finished. Report: data_cache\selftest.txt
