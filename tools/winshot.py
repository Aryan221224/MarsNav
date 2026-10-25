"""Test helper: picture of one window (by exact title) with PrintWindow - only that window, even when it is covered.

    python tools/winshot.py "MarsNav" out.png
"""
import ctypes
import sys
from ctypes import wintypes as wt

from PIL import Image

u, g = ctypes.windll.user32, ctypes.windll.gdi32
ctypes.windll.shcore.SetProcessDpiAwareness(2)
hwnd = u.FindWindowW(None, sys.argv[1])
if not hwnd:
    raise SystemExit(f"no window titled {sys.argv[1]!r}")
r = wt.RECT()
u.GetWindowRect(hwnd, ctypes.byref(r))
w, h = r.right - r.left, r.bottom - r.top
hdc = u.GetWindowDC(hwnd)
mdc = g.CreateCompatibleDC(hdc)
bmp = g.CreateCompatibleBitmap(hdc, w, h)
g.SelectObject(mdc, bmp)
ok = u.PrintWindow(hwnd, mdc, 2)                       # PW_RENDERFULLCONTENT (includes the WebView2 content)


class BMI(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD), ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
                ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD)]


bi = BMI(ctypes.sizeof(BMI), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
buf = ctypes.create_string_buffer(w * h * 4)
g.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)
Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB").save(sys.argv[2])
g.DeleteObject(bmp)
g.DeleteDC(mdc)
u.ReleaseDC(hwnd, hdc)
print(f"saved {sys.argv[2]} {w}x{h} printwindow={ok} iconic={u.IsIconic(hwnd)}")
