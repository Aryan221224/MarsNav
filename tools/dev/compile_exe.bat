@echo off
rem Recompile MarsNav.exe only (no pip install, no packaging): used during development. build_exe.bat does the full build.
cd /d "%~dp0..\.."
set OPENBLAS_NUM_THREADS=1
set OMP_NUM_THREADS=1
set MKL_NUM_THREADS=1
if not exist ".buildwork\tmp" mkdir ".buildwork\tmp"
set "TEMP=%cd%\.buildwork\tmp"
set "TMP=%cd%\.buildwork\tmp"
set "VENV_PY=%cd%\.buildvenv\Scripts\python.exe"
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
    echo BUILD FAILED
    exit /b 1
)
echo BUILD OK
