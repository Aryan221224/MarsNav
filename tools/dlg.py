"""Test helper: list top-level dialog windows of a process tree, save a picture of one, and close it.

    python tools/dlg.py list
    python tools/dlg.py shot <out.png>      (the first standard dialog, class #32770)
    python tools/dlg.py save <full path>    (type a path into the Save dialog and press Save)
    python tools/dlg.py cancel
"""
import ctypes
import subprocess
import sys
import time
from ctypes import wintypes as wt

u = ctypes.windll.user32
ctypes.windll.shcore.SetProcessDpiAwareness(2)
EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def dialogs():
    out = []

    def cb(h, _):
        cls = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, cls, 256)
        if cls.value == "#32770" and u.IsWindowVisible(h):
            t = ctypes.create_unicode_buffer(256)
            u.GetWindowTextW(h, t, 256)
            out.append((h, t.value))
        return True
    u.EnumWindows(EnumProc(cb), 0)
    return out


def child_edit(h):
    found = []

    def cb(c, _):
        cls = ctypes.create_unicode_buffer(64)
        u.GetClassNameW(c, cls, 64)
        if cls.value == "Edit":
            found.append(c)
        return True
    u.EnumChildWindows(h, EnumProc(cb), 0)
    return found


cmd = sys.argv[1]
ds = dialogs()
if cmd == "list":
    print(ds)
elif not ds:
    print("no dialog")
elif cmd == "shot":
    h = ds[0][0]
    subprocess.run([sys.executable, "tools/winshot.py", ds[0][1], sys.argv[2]])
elif cmd == "save":
    h = ds[0][0]
    edits = child_edit(h)
    if edits:
        u.SendMessageW(edits[0], 0x000C, 0, ctypes.c_wchar_p(sys.argv[2]))     # WM_SETTEXT
        time.sleep(0.3)
        u.SendMessageW(h, 0x0111, 1, 0)                                        # WM_COMMAND IDOK
        print("saved via", ds[0][1])
    else:
        print("no edit box")
elif cmd == "cancel":
    u.PostMessageW(ds[0][0], 0x0111, 2, 0)                                     # IDCANCEL
    print("cancelled", ds[0][1])
