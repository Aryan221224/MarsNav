#!/usr/bin/env bash
# Rebuild Build_MarsNav.exe (the double-click wrapper around build_exe.bat) with MinGW-w64, from Linux or MSYS2:
#   sudo apt-get install gcc-mingw-w64-x86-64   (once)
#   bash tools/build_launcher/make.sh
set -euo pipefail
cd "$(dirname "$0")"
x86_64-w64-mingw32-windres build_marsnav.rc -O coff -o build_marsnav.res
x86_64-w64-mingw32-gcc -O2 -s -municode -static -o ../../Build_MarsNav.exe build_marsnav.c build_marsnav.res
rm -f build_marsnav.res
echo "built $(cd ../.. && pwd)/Build_MarsNav.exe"
