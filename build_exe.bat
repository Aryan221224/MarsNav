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

rem One-folder build (not one-file): a one-file exe unpacks ~220 MB into the system temp folder on every start, leaves it
rem behind whenever it is killed, and cannot start at all when that drive is full. The one-folder build starts at once
rem and writes nothing to the system drive. Its libraries live in MarsNav_runtime\ next to MarsNav.exe.
echo.
echo Building MarsNav.exe with PyInstaller...
if exist ".buildwork\dist" rmdir /s /q ".buildwork\dist"
"%VENV_PY%" -m PyInstaller --noconfirm --onedir --windowed --name MarsNav ^
    --contents-directory MarsNav_runtime ^
    --icon "%cd%\launcher\marsnav.ico" ^
    --version-file "%cd%\launcher\version_info.txt" ^
    --paths . ^
    --paths pipeline ^
    --paths launcher ^
    --collect-submodules planet ^
    --hidden-import desktop ^
    --hidden-import wintheme ^
    --hidden-import build_imagery ^
    --hidden-import build_layers ^
    --hidden-import build_terrain ^
    --hidden-import fetch_data ^
    --hidden-import fit_meda ^
    --hidden-import mars_geo ^
    --hidden-import mars_time ^
    --hidden-import sitecfg ^
    --hidden-import targets ^
    --hidden-import scipy.sparse.csgraph ^
    --hidden-import scipy.ndimage ^
    --hidden-import clr ^
    --collect-data certifi ^
    --collect-all rasterio ^
    --collect-all affine ^
    --collect-all webview ^
    --collect-all pythonnet ^
    --collect-all clr_loader ^
    --exclude-module PyQt5 --exclude-module PyQt6 --exclude-module PySide2 --exclude-module PySide6 ^
    --exclude-module gi --exclude-module cefpython3 --exclude-module pytest ^
    --distpath .buildwork\dist --workpath .buildwork --specpath .buildwork ^
    launcher\martian_map.py

if not exist ".buildwork\dist\MarsNav\MarsNav.exe" (
    echo.
    echo BUILD FAILED - MarsNav.exe was not produced. See the messages above.
    pause
    exit /b 1
)

echo.
echo Assembling the portable program for other PCs (dist\MarsNav and dist\MarsNav-Windows.zip)...
"%VENV_PY%" launcher\make_portable.py ".buildwork\dist\MarsNav" "%cd%" 2.0.0
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
