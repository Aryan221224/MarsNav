"""Assemble the portable MarsNav folder and zip from a PyInstaller build (called by build_exe.bat).

    python launcher/make_portable.py <build folder with MarsNav.exe + MarsNav_runtime> <project folder>

Writes  <project>/dist/MarsNav/           the program: copy this folder to any Windows 10/11 PC and double-click
                                               MarsNav.exe (no Python, no installation, no admin rights)
        <project>/dist/MarsNav-Windows.zip  the same folder as one file, to send or put on a USB stick
"""
from __future__ import annotations

import shutil
import sys
import time
import zipfile
from pathlib import Path

SKIP_DIRS = {"__pycache__", ".pytest_cache", ".git"}
SKIP_SUFFIX = {".pyc", ".pyo", ".orig.js", ".log"}

START_HERE = """MARSNAV {version} - START HERE
================================

Landing / hub site selection and EVA traverse planning for human Mars exploration,
on real NASA and USGS Mars data. NASA Space Apps Challenge 2026.

TO RUN
  Double-click  MarsNav.exe
  The app opens in its own window. Nothing to install: no Python, no admin rights.

  First time on a new PC:
    * If Windows shows "Windows protected your PC" (the program is not code-signed),
      click "More info", then "Run anyway". This happens only once.
    * The first start can take up to a minute while Windows checks the program files.
    * MarsNav menu > "Add desktop and Start menu shortcuts" adds the usual shortcuts.

KEEP TOGETHER
  MarsNav.exe needs the folders next to it (MarsNav_runtime, app, planet, pipeline).
  Move or copy the whole "MarsNav" folder, never the .exe alone. Put it anywhere you can
  save files (Desktop, Documents, D:\\, a USB drive) - not in C:\\Program Files.

INTERNET AND OFFLINE (MARS) USE
  * The Jezero EVA planner works fully offline from the data included here.
  * Landing mode streams whole-planet data from NASA / USGS the first time you look at a
    place, and keeps everything it has loaded in the data_cache folder.
  * Data > Local mode downloads whole-planet datasets and full-resolution zones in advance;
    then switch on Mars mode and the app runs with no internet at all.

WHERE THINGS ARE
  data_cache\\     everything the app downloads or builds (maps, tiles, Local mode data, logs)
  MarsNav_User_Guide.pdf   the user guide (also Help > User guide)

REQUIREMENTS
  Windows 10 or 11, 64-bit, 4 GB RAM (8 GB recommended), about 600 MB of disk plus room for data.
  The window uses Microsoft Edge WebView2, which is part of Windows 10 and 11. On a PC without it,
  MarsNav opens in a Microsoft Edge app window instead.

TO REMOVE
  Delete the "MarsNav" folder (and the shortcuts, if you added them).
"""


def _copytree(src: Path, dst: Path) -> int:
    n = 0
    for p in src.rglob("*"):
        rel = p.relative_to(src)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if p.is_file():
            if any(p.name.endswith(s) for s in SKIP_SUFFIX):
                continue
            q = dst / rel
            q.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, q)
            n += 1
    return n


def main() -> int:
    build, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    version = sys.argv[3] if len(sys.argv) > 3 else "2.1.0"
    exe = build / "MarsNav.exe"
    if not exe.exists():
        print(f"make_portable: {exe} not found")
        return 1
    dist = root / "dist"
    out = dist / "MarsNav"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    t0 = time.time()
    shutil.copy2(exe, out / "MarsNav.exe")
    n = _copytree(build / "MarsNav_runtime", out / "MarsNav_runtime")
    for d in ("app", "planet", "pipeline"):
        n += _copytree(root / d, out / d)
    for f in ("MarsNav_User_Guide.pdf", "LICENSE"):
        if (root / f).exists():
            shutil.copy2(root / f, out / f)
            n += 1
    (out / "START HERE.txt").write_text(START_HERE.format(version=version).replace("\n", "\r\n"), encoding="utf-8")
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"portable folder: {out}  ({n + 2} files, {size / 2**20:.0f} MB, {time.time() - t0:.0f} s)")

    z = dist / "MarsNav-Windows.zip"
    tmp = z.with_suffix(".zip.part")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for p in sorted(out.rglob("*")):
            if p.is_file():
                zf.write(p, Path("MarsNav") / p.relative_to(out))
    tmp.replace(z)
    print(f"zip: {z}  ({z.stat().st_size / 2**20:.0f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
