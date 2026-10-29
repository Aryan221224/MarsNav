@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem numpy/scipy start one OpenBLAS thread per CPU and commit ~32 MB for each: PyInstaller imports every package while
rem it analyses them, which crashed its subprocess on a machine short of memory. One thread is plenty for a build.
set OPENBLAS_NUM_THREADS=1
set OMP_NUM_THREADS=1
set MKL_NUM_THREADS=1
rem temporary files on this drive, not the (possibly full) system drive
if not exist ".buildwork\tmp" mkdir ".buildwork\tmp"
set "TEMP=%cd%\.buildwork\tmp"
set "TMP=%cd%\.buildwork\tmp"

rem the build replaces MarsNav.exe and its runtime folder, which Windows locks while they run: close any running copy
taskkill /IM MarsNav.exe /F >nul 2>nul
timeout /t 2 /nobreak >nul

echo ============================================================
echo   MarsNav - building the desktop app (MarsNav.exe)
echo ============================================================
echo.
echo This will:
echo   1. Create a private build environment in .buildvenv\
echo   2. Install numpy, scipy, rasterio, pywebview and the other packages
echo      from requirements.txt, plus PyInstaller
echo   3. Compile launcher\martian_map.py + launcher\desktop.py into
echo      MarsNav.exe (a windowed program: the app in its own window),
echo      with its libraries in the MarsNav_runtime folder next to it
echo   4. Assemble the portable program for other PCs:
echo        dist\MarsNav\                (copy this folder anywhere)
echo        dist\MarsNav-Windows.zip      (the same, as one file)
echo.
echo You only need to run this once. After that, just double-click
echo MarsNav.exe to launch the app.
echo.

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYLAUNCH=py -3"
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        set "PYLAUNCH=python"
    ) else (
        echo Python was not found on PATH.
        echo Install Python 3.10 or later from https://www.python.org/downloads/
        echo and tick "Add python.exe to PATH" during install, then run this
        echo file again.
        pause
        exit /b 1
    )
)

echo Using: %PYLAUNCH%
%PYLAUNCH% --version
if errorlevel 1 (
    echo Could not run Python. Aborting.
    pause
    exit /b 1
)

if not exist ".buildvenv\Scripts\python.exe" (
    echo.
    echo Creating build environment .buildvenv ...
    %PYLAUNCH% -m venv .buildvenv
    if errorlevel 1 (
        echo Failed to create the virtual environment.
        pause
        exit /b 1
    )
)

set "VENV_PY=%cd%\.buildvenv\Scripts\python.exe"

echo.
echo Installing dependencies (this can take several minutes the first time)...
"%VENV_PY%" -m pip install --upgrade pip
"%VENV_PY%" -m pip install -r requirements.txt
"%VENV_PY%" -m pip install pyinstaller pyinstaller-hooks-contrib
if errorlevel 1 (
    echo.
    echo pip install failed. See the messages above.
    pause
    exit /b 1
)

rem The PyInstaller recipe lives in tools\build_windows.py, shared with the GitHub Actions build of the release zip.
echo.
echo Building MarsNav.exe with PyInstaller...
"%VENV_PY%" tools\build_windows.py

if not exist ".buildwork\dist\MarsNav\MarsNav.exe" (
    echo.
    echo BUILD FAILED - MarsNav.exe was not produced. See the messages above.
    pause
    exit /b 1
)

echo.
echo Assembling the portable program for other PCs (dist\MarsNav and dist\MarsNav-Windows.zip)...
"%VENV_PY%" launcher\make_portable.py ".buildwork\dist\MarsNav" "%cd%" 2.1.0
if errorlevel 1 (
    echo Could not assemble the portable folder - is a copy of it still open in dist\MarsNav?
)

rem put the new program in place of the old one (the old runtime folder is build output, rebuilt every time)
if exist "MarsNav_runtime" rmdir /s /q "MarsNav_runtime"
if exist "MarsNav_runtime" (
    echo.
    echo Could not replace MarsNav_runtime - is MarsNav still running? Close its window and run this again.
    pause
    exit /b 1
)
move /y ".buildwork\dist\MarsNav\MarsNav.exe" "MarsNav.exe" >nul
move ".buildwork\dist\MarsNav\MarsNav_runtime" "MarsNav_runtime" >nul
if not exist "MarsNav_runtime" (
    echo BUILD FAILED - could not move the runtime folder into place.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Build complete: MarsNav.exe  (+ MarsNav_runtime\)
echo ============================================================
echo.
echo Launching it now as a quick check: the MarsNav window should open.
echo To check the server end to end under load, run selftest.bat.
echo For other PCs, copy dist\MarsNav (or dist\MarsNav-Windows.zip).
echo.
start "" "MarsNav.exe"

echo.
echo Done. From now on, just double-click MarsNav.exe to launch the app.
pause
