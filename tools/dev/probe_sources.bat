@echo off
rem Checks that every NASA / USGS data source the app uses is reachable and answering
cd /d "%~dp0..\.."
title MarsNav - data source check
".buildvenv\Scripts\python.exe" tools\probe_sources.py
