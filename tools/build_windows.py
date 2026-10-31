"""Compile MarsNav.exe with PyInstaller (Windows) and, with --portable, assemble the folder and zip for other PCs.

One build recipe for everyone: build_exe.bat calls it on a PC, and the GitHub Actions workflow
(.github/workflows/windows-exe.yml) calls it on a clean Windows machine to publish MarsNav-Windows.zip.

    python tools/build_windows.py              .buildwork/dist/MarsNav/  (MarsNav.exe + MarsNav_runtime)
    python tools/build_windows.py --portable   also dist/MarsNav/ and dist/MarsNav-Windows.zip

One-folder build (not one-file): a one-file exe unpacks ~220 MB into the system temp folder on every start, leaves it
behind whenever it is killed, and cannot start at all when that drive is full. The one-folder build starts at once and
writes nothing to the system drive. Its libraries live in MarsNav_runtime next to MarsNav.exe."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = "2.1.0"
# modules PyInstaller cannot see by following imports: the pipeline is imported by path, the window by name
HIDDEN = ["desktop", "wintheme", "build_imagery", "build_layers", "build_terrain", "fetch_data", "fit_meda", "mars_geo",
          "mars_time", "sitecfg", "targets", "scipy.sparse.csgraph", "scipy.ndimage", "clr"]
COLLECT_ALL = ["rasterio", "affine", "webview", "pythonnet", "clr_loader"]
EXCLUDE = ["PyQt5", "PyQt6", "PySide2", "PySide6", "gi", "cefpython3", "pytest"]


def pyinstaller_args() -> list[str]:
    work = ROOT / ".buildwork"
    a = ["--noconfirm", "--onedir", "--windowed", "--name", "MarsNav", "--contents-directory", "MarsNav_runtime",
         "--icon", str(ROOT / "launcher" / "marsnav.ico"), "--version-file", str(ROOT / "launcher" / "version_info.txt"),
         "--paths", str(ROOT), "--paths", str(ROOT / "pipeline"), "--paths", str(ROOT / "launcher"),
         "--collect-submodules", "planet", "--collect-data", "certifi"]
    for m in HIDDEN:
        a += ["--hidden-import", m]
    for m in COLLECT_ALL:
        a += ["--collect-all", m]
    for m in EXCLUDE:
        a += ["--exclude-module", m]
    a += ["--distpath", str(work / "dist"), "--workpath", str(work), "--specpath", str(work), str(ROOT / "launcher" / "martian_map.py")]
    return a


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--portable", action="store_true", help="also assemble dist/MarsNav and dist/MarsNav-Windows.zip")
    a = ap.parse_args()
    if os.name != "nt":
        print("MarsNav.exe is a Windows program: build it on Windows (or let the GitHub Actions workflow build it).")
        return 2
    env = dict(os.environ)
    # numpy / scipy start one OpenBLAS thread per CPU while PyInstaller imports them, which crashed its subprocess on a
    # machine short of memory. One thread is plenty for a build.
    env.update(OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1")
    tmp = ROOT / ".buildwork" / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    env.update(TEMP=str(tmp), TMP=str(tmp))               # temporary files on this drive, not the system drive
    dist = ROOT / ".buildwork" / "dist"
    if dist.exists():
        shutil.rmtree(dist)
    print("Building MarsNav.exe with PyInstaller...", flush=True)
    r = subprocess.run([sys.executable, "-m", "PyInstaller", *pyinstaller_args()], cwd=ROOT, env=env)
    exe = dist / "MarsNav" / "MarsNav.exe"
    if r.returncode or not exe.exists():
        print("BUILD FAILED - MarsNav.exe was not produced. See the messages above.")
        return 1
    print(f"built {exe}", flush=True)
    if a.portable:
        r = subprocess.run([sys.executable, str(ROOT / "launcher" / "make_portable.py"), str(dist / "MarsNav"), str(ROOT), VERSION], cwd=ROOT, env=env)
        if r.returncode:
            return r.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
