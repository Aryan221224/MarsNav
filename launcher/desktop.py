"""MarsNav desktop shell: the app in its own native window, not a browser tab.

The window is a native Win32 window with Microsoft Edge WebView2 inside it (the same engine Windows uses for Outlook, Teams
and Widgets; it is part of Windows 10 and 11), driven through pywebview. The local server, its raster workers and its jobs
run exactly as before (martian_map.Supervisor); this module only replaces the console menu and the browser tab with:

  * a native window with a menu bar (MarsNav / View / Data / Help), its own icon and taskbar entry,
  * a start-up screen while the map engine starts, and a clear message if it cannot,
  * the rover drive window and printable dossiers as further native windows (not browser pop-ups),
  * native Save dialogs for every export,
  * window size, position and last page remembered between runs,
  * one copy at a time (starting it again brings the open window to the front),
  * closing the window stops everything it started,
  * a dark title bar and menu bar in the app's console colours (launcher/wintheme.py).

If WebView2 is missing (a very old, never-updated Windows 10), it falls back to Microsoft Edge or Chrome in app mode (a
plain window without tabs or address bar), and as a last resort to the default browser.
"""
from __future__ import annotations

import base64
import contextlib
import ctypes
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from pathlib import Path

TITLE = "MarsNav"
VERSION = "2.0.0"
WIN = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000

MM = None                       # the martian_map launcher module (set by run())
S: dict = {"main": None, "sup": None, "root": None, "url": None, "port": None, "windows": {}, "pending_js": None,
           "state": {}, "booted": False, "quitting": False, "error": None}


# ------------------------------------------------------------------------------------------------ small Windows helpers

def message_box(text: str, title: str = TITLE, flags: int = 0x40) -> int:
    """A native message box (0x40 information, 0x30 warning, 0x10 error, | 0x4 yes/no -> 6 yes / 7 no)."""
    if WIN:
        with contextlib.suppress(Exception):
            return ctypes.windll.user32.MessageBoxW(None, str(text), str(title), flags | 0x10000)   # MB_SETFOREGROUND
    print(f"{title}: {text}")
    return 0


def focus_existing() -> bool:
    """Bring the already-open MarsNav window to the front."""
    if not WIN:
        return False
    u = ctypes.windll.user32
    for _ in range(40):                                  # the other copy may still be opening its window
        hwnd = u.FindWindowW(None, TITLE)
        if hwnd:
            if u.IsIconic(hwnd):
                u.ShowWindow(hwnd, 9)                    # SW_RESTORE
            u.SetForegroundWindow(hwnd)
            return True
        time.sleep(0.25)
    return False


def webview2_version() -> str | None:
    """Version of the installed Microsoft Edge WebView2 Runtime, or None when it is missing."""
    if not WIN:
        return None
    import winreg
    guid = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for hive, sub in ((winreg.HKEY_LOCAL_MACHINE, "SOFTWARE\\WOW6432Node\\" + guid),
                      (winreg.HKEY_LOCAL_MACHINE, "SOFTWARE\\" + guid),
                      (winreg.HKEY_CURRENT_USER, "Software\\" + guid)):
        with contextlib.suppress(OSError):
            with winreg.OpenKey(hive, sub) as k:
                v = str(winreg.QueryValueEx(k, "pv")[0] or "")
                if v and v != "0.0.0.0":
                    return v
    # Edge itself carries a WebView2-capable runtime folder on most machines even without the registry entry
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if base:
            d = Path(base) / "Microsoft" / "EdgeWebView" / "Application"
            if d.exists() and any(p.is_dir() and p.name[:1].isdigit() for p in d.iterdir()):
                return "found"
    return None


def find_app_browser() -> str | None:
    """Microsoft Edge or Google Chrome (for the app-mode fallback window)."""
    cands = []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands += [Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                      Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe"]
    for c in cands:
        if c.exists():
            return str(c)
    return None


def redirect_std(root: Path) -> None:
    """A windowed program has no console: keep print() and tracebacks in data_cache/desktop.log."""
    if sys.stdout is None or sys.stderr is None:
        with contextlib.suppress(OSError):
            f = open(root / "data_cache" / "desktop.log", "a", encoding="utf-8", buffering=1)
            f.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} MarsNav {VERSION} (pid {os.getpid()}) ---\n")
            if sys.stdout is None:
                sys.stdout = f
            if sys.stderr is None:
                sys.stderr = f


def unblock_own_files(root: Path) -> int:
    """Files unpacked from a downloaded zip carry Windows' "came from the internet" mark (the Zone.Identifier stream),
    and .NET then refuses to load the window's DLLs (Microsoft.Web.WebView2.*, Python.Runtime). Remove the mark from
    this program's own files - what Explorer's Properties > Unblock does. Only when the mark is actually there."""
    if not WIN:
        return 0
    rt = root / "MarsNav_runtime"
    probe = [p for p in (rt / "pythonnet" / "runtime" / "Python.Runtime.dll", Path(sys.executable)) if p.exists()]
    if not any(os.path.exists(str(p) + ":Zone.Identifier") for p in probe):
        return 0
    n = 0
    for base in (rt, root):
        if not base.exists():
            continue
        it = base.rglob("*") if base == rt else base.glob("*.exe")
        for p in it:
            if p.suffix.lower() in (".dll", ".exe", ".pyd", ".json", ".config", ".js") and p.is_file():
                with contextlib.suppress(OSError):
                    os.remove(str(p) + ":Zone.Identifier")
                    n += 1
    return n


def log(msg: str) -> None:
    with contextlib.suppress(Exception):
        MM.server_log(f"desktop: {msg}")


# ------------------------------------------------------------------------------------------------ remembered state

def _state_file() -> Path:
    return S["root"] / "data_cache" / "desktop.json"


def load_state() -> dict:
    try:
        return json.loads(_state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state() -> None:
    with contextlib.suppress(Exception):
        _state_file().write_text(json.dumps(S["state"], indent=1), encoding="utf-8")


def _on_screen(x, y, w, h) -> bool:
    """True when a remembered window position is still on a connected monitor."""
    if not WIN or x is None or y is None:
        return False
    with contextlib.suppress(Exception):
        u = ctypes.windll.user32
        vx, vy = u.GetSystemMetrics(76), u.GetSystemMetrics(77)          # virtual screen origin
        vw, vh = u.GetSystemMetrics(78), u.GetSystemMetrics(79)
        return vx - 50 <= x <= vx + vw - 200 and vy - 10 <= y <= vy + vh - 150
    return False


# ------------------------------------------------------------------------------------------------ the start-up screen

SPLASH = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0d10;color:#e9e4dc;font:15px/1.5 "Segoe UI",system-ui,sans-serif;overflow:hidden}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
.logo{width:190px;height:190px;filter:drop-shadow(0 0 28px rgba(226,110,70,.35));animation:pulse 3.2s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.025)}}
h1{margin:0;font-size:30px;letter-spacing:.32em;font-weight:600}h1 b{color:#e8925a;font-weight:600}
.sub{color:#8f969e;letter-spacing:.08em;font-size:13px;margin-top:-14px}
.bar{width:300px;height:4px;background:#1f252c;border-radius:4px;overflow:hidden}
.bar i{display:block;height:100%;width:35%;background:#e8925a;border-radius:4px;animation:go 1.4s ease-in-out infinite}
@keyframes go{0%{margin-left:-35%}100%{margin-left:100%}}
#st{color:#b9bfc6;min-height:22px;text-align:center;max-width:640px}
#err{display:none;max-width:680px;background:#2a1212;border:1px solid #6b2a2a;border-radius:8px;padding:14px 18px;color:#f1c9c9;white-space:pre-wrap;font-size:13px}
.ver{position:fixed;bottom:12px;right:16px;color:#4d545c;font-size:12px}
</style></head><body><div class="wrap">__LOGO__<h1>MARS<b>NAV</b></h1>
<div class="sub">Landing site selection and EVA traverse planning for human Mars exploration</div>
<div class="bar" id="bar"><i></i></div><div id="st">Starting the map engine&hellip;</div><div id="err"></div></div>
<div class="ver">version __VER__</div>
<script>
function mmStatus(t){document.getElementById('st').textContent=t}
function mmError(t){document.getElementById('bar').style.display='none';var e=document.getElementById('err');e.style.display='block';e.textContent=t}
</script></body></html>""".replace("__VER__", VERSION)


def splash_html(root: Path) -> str:
    """The start-up screen, with the MarsNav logo from app/logo-512.png embedded (the server is not running yet)."""
    logo = ""
    for name in ("logo-512.png", "logo-192.png"):
        with contextlib.suppress(OSError):
            data = base64.b64encode((root / "app" / name).read_bytes()).decode()
            logo = f'<img class="logo" alt="" src="data:image/png;base64,{data}">'
            break
    return SPLASH.replace("__LOGO__", logo)


def _js_str(s: str) -> str:
    return json.dumps(str(s))


def splash_status(msg: str) -> None:
    w = S["main"]
    if w is not None and not S["booted"]:
        with contextlib.suppress(Exception):
            w.evaluate_js(f"window.mmStatus && mmStatus({_js_str(msg)})")


def splash_error(msg: str) -> None:
    S["error"] = msg
    w = S["main"]
    if w is not None:
        with contextlib.suppress(Exception):
            w.evaluate_js(f"window.mmError && mmError({_js_str(msg)})")


# ------------------------------------------------------------------------------------------------ the JS bridge

def _safe_name(s: str, default: str = "file") -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(s or "")).strip(" .")
    return s[:120] or default


def _feature(features: str, key: str, default: int) -> int:
    m = re.search(rf"\b{key}\s*=\s*(\d+)", features or "")
    return int(m.group(1)) if m else default


def theme_window(w) -> None:
    """Dark title bar and menu bar for a window (launcher/wintheme.py), as soon as it exists. Cosmetic: never fatal."""
    if not WIN:
        return

    def run():
        t0 = time.time()
        with contextlib.suppress(Exception):
            w.events.shown.wait(15)
        while getattr(w, "native", None) is None and time.time() - t0 < 15:
            time.sleep(0.1)
        try:
            import wintheme
            wintheme.apply(w, log)
        except Exception as e:  # noqa: BLE001
            log(f"window theme unavailable: {type(e).__name__}: {e}")
    threading.Thread(target=run, daemon=True, name="window-theme").start()


class Bridge:
    """Called from the page as window.pywebview.api.<name>(...) (app/js/desktop.js). Only public methods are exposed,
    and this object deliberately holds no attributes (pywebview would try to expose them too)."""

    def info(self):
        return {"desktop": True, "version": VERSION, "data": str(S["root"] / "data_cache"), "port": S["port"]}

    def open_window(self, url, name="", features=""):
        """A same-site pop-up (the rover drive window): a further native window. Reuses the window of the same name."""
        import webview
        key = str(name or url)
        w = S["windows"].get(key)
        if w is not None and w in webview.windows:
            with contextlib.suppress(Exception):
                w.load_url(url)
                w.restore()
                w.show()
            return True
        title = TITLE + (" · Drive" if "drive" in url else "")
        w = webview.create_window(title, url, js_api=Bridge(), width=_feature(features, "width", 1400),
                                  height=_feature(features, "height", 860), min_size=(800, 560), text_select=True,
                                  zoomable=True, background_color="#0b0d10")
        S["windows"][key] = w
        w.events.closed += lambda: S["windows"].pop(key, None)
        theme_window(w)
        log(f"opened window {key!r} -> {url}")
        return True

    def close_window(self, name=""):
        w = S["windows"].pop(str(name), None)
        if w is not None:
            with contextlib.suppress(Exception):
                w.destroy()
        return True

    def open_document(self, html, title="Document", filename="document.html"):
        """A generated report (the hub site dossier): saved under data_cache/reports and shown in its own window, where
        its Print button works (print or save as PDF)."""
        import webview
        d = S["root"] / "data_cache" / "reports"
        d.mkdir(parents=True, exist_ok=True)
        f = d / _safe_name(filename, "document.html")
        if f.suffix.lower() not in (".html", ".htm"):
            f = f.with_suffix(".html")
        f.write_text(str(html), encoding="utf-8")
        doc = webview.create_window(_safe_name(title, TITLE), f.as_uri(), js_api=Bridge(), width=1000, height=900,
                                    text_select=True, zoomable=True)
        theme_window(doc)
        log(f"report {f.name} ({f.stat().st_size} bytes)")
        return str(f)

    def save_file(self, filename, b64data):
        """An export (JSON, CSV, GPX, HTML ...): a native Save dialog, then the file is written. Returns the path or ''."""
        import webview
        w = S["main"]
        filename = _safe_name(filename, "export")
        ext = Path(filename).suffix.lstrip(".") or "*"
        dl = Path.home() / "Downloads"
        fd = getattr(webview, "FileDialog", None)
        kind = fd.SAVE if fd is not None else webview.SAVE_DIALOG
        try:
            res = w.create_file_dialog(kind, directory=str(dl if dl.exists() else Path.home()), save_filename=filename,
                                       file_types=(f"{ext.upper()} file (*.{ext})", "All files (*.*)"))
        except Exception:  # noqa: BLE001 - some versions reject the file type list: try without it
            res = w.create_file_dialog(kind, directory=str(dl if dl.exists() else Path.home()), save_filename=filename)
        if not res:
            return ""
        path = res[0] if isinstance(res, (list, tuple)) else res
        data = base64.b64decode(b64data.split(",", 1)[-1] if str(b64data).startswith("data:") else b64data)
        Path(path).write_bytes(data)
        log(f"saved {path} ({len(data)} bytes)")
        return str(path)

    def open_external(self, url):
        """A link to another site (NASA abstracts, sources): the user's normal web browser."""
        if re.match(r"^https?://", str(url or ""), re.I):
            webbrowser.open(str(url))
            return True
        return False

    def toggle_fullscreen(self):
        with contextlib.suppress(Exception):
            S["main"].toggle_fullscreen()
        return True


# ------------------------------------------------------------------------------------------------ menu actions

def _main():
    return S["main"]


def go(path: str, then_js: str | None = None) -> None:
    if not S["booted"]:
        return
    w = _main()
    cur = ""
    with contextlib.suppress(Exception):
        cur = w.get_current_url() or ""
    target = S["url"].rstrip("/") + path
    if then_js and cur.split("#")[0].endswith(path.split("#")[0]):
        w.evaluate_js(then_js)
        return
    S["pending_js"] = then_js
    w.load_url(target)


def act_reload():
    with contextlib.suppress(Exception):
        _main().evaluate_js("location.reload()")


def act_back():
    with contextlib.suppress(Exception):
        _main().evaluate_js("history.back()")


def act_fullscreen():
    with contextlib.suppress(Exception):
        _main().toggle_fullscreen()


def act_local_mode():
    go("/landing.html", "setTimeout(function(){var b=document.getElementById('localPill');if(b)b.click();},900)")


def act_open_folder(sub: str = ""):
    p = S["root"] / "data_cache" / sub if sub else S["root"] / "data_cache"
    p.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(Exception):
        os.startfile(str(p))  # noqa: S606 - opens Explorer on our own folder


def act_rebuild(full: bool = False):
    if message_box("Rebuild the Jezero data products from the raw NASA / USGS sources?\n\n"
                   "This downloads up to about 0.9 GB (more with the 1 m DTMs) and takes about 10 minutes. "
                   "Progress is shown in a separate window; you can keep using the map meanwhile.",
                   TITLE, 0x24) != 6:
        return
    with contextlib.suppress(Exception):
        subprocess.Popen(MM.self_cmd("--rebuild", *(["--full"] if full else [])), cwd=str(S["root"]),
                         stdin=subprocess.DEVNULL, close_fds=True)


def act_status():
    sup = S["sup"]
    lines = [f"MarsNav {VERSION}", f"Address: {S['url']}", f"Program folder: {S['root']}",
             f"Data folder: {S['root'] / 'data_cache'}", f"Window engine: Microsoft Edge WebView2 {webview2_version() or '?'}"]
    if sup is not None:
        h = sup.health(5) or {}
        with contextlib.suppress(Exception):
            c = sup.job_census()
            lines += ["", f"Map engine: pid {h.get('pid')}, up {h.get('uptime_s')} s, {h.get('served')} requests served, "
                          f"busy {h.get('busy')}/{h.get('threads')}, restarts in 10 min: {len(sup.restarts)}",
                      f"Memory: {c['total_mb']} MB in {len(c['pids'])} processes; Windows commit free "
                      f"{c['memory'].get('commit_free_mb')} of {c['memory'].get('commit_limit_mb')} MB"]
            w = h.get("workers") or {}
            lines.append(f"Raster workers: {w.get('live')}/{w.get('max')} live, {w.get('calls')} reads, "
                         f"{w.get('timeouts')} timed out, {w.get('errors')} failed")
    with contextlib.suppress(Exception):
        lines.append(f"Disk free: program drive {MM.disk_free_gb(S['root'])} GB, system drive "
                     f"{MM.disk_free_gb(MM.system_drive())} GB")
    message_box("\n".join(lines), TITLE + " · status")


def act_guide():
    for c in (S["root"] / "MarsNav_User_Guide.pdf", S["root"] / "docs" / "MarsNav_User_Guide.pdf"):
        if c.exists():
            with contextlib.suppress(Exception):
                os.startfile(str(c))  # noqa: S606
                return
    message_box("The user guide (MarsNav_User_Guide.pdf) is not in the program folder.")


def act_shortcuts():
    """Desktop and Start menu shortcuts to this copy of MarsNav (what an installer would add)."""
    exe = Path(sys.executable).resolve() if MM.is_frozen() else None
    if exe is None:
        message_box("Shortcuts can be made from MarsNav.exe (not when running from the Python source).")
        return
    ps = ("$sh=New-Object -ComObject WScript.Shell; "
          "foreach($d in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))){ "
          "$s=$sh.CreateShortcut((Join-Path $d 'MarsNav.lnk')); "
          f"$s.TargetPath='{exe}'; $s.WorkingDirectory='{exe.parent}'; $s.IconLocation='{exe},0'; "
          "$s.Description='MarsNav - EVA planning and landing site selection for Mars'; $s.Save() }")
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW if WIN else 0)
    if r.returncode == 0:
        message_box("Added 'MarsNav' to your desktop and to the Start menu.")
    else:
        message_box(f"Could not create the shortcuts:\n{(r.stderr or r.stdout).strip()[:600]}", TITLE, 0x30)


def act_about():
    message_box(f"MarsNav {VERSION}\n\nLanding / hub site selection, and EVA traverse planning and guidance, "
                "for human Mars exploration, on real NASA and USGS Mars data.\n\nNASA Space Apps Challenge 2026 - "
                "Interplanetary Survival Guide: Martian Map.\n\n"
                f"Window engine: Microsoft Edge WebView2 {webview2_version() or '(not found)'}\n"
                f"Program folder: {S['root']}", "About " + TITLE)


def act_quit():
    with contextlib.suppress(Exception):
        _main().destroy()


def build_menu():
    from webview.menu import Menu, MenuAction, MenuSeparator
    return [
        Menu("MarsNav", [
            MenuAction("Landing mode  (hub site selection)", lambda: go("/landing.html")),
            MenuAction("EVA planner  (Jezero traverse planning)", lambda: go("/index.html")),
            MenuAction("Jezero east demo site", lambda: go("/index.html#jezero_east")),
            MenuSeparator(),
            MenuAction("Add desktop and Start menu shortcuts", act_shortcuts),
            MenuSeparator(),
            MenuAction("Quit", act_quit),
        ]),
        Menu("View", [
            MenuAction("Reload page   (F5)", act_reload),
            MenuAction("Back", act_back),
            MenuAction("Full screen   (F11)", act_fullscreen),
        ]),
        Menu("Data", [
            MenuAction("Local mode: download the data for offline use...", act_local_mode),
            MenuSeparator(),
            MenuAction("Rebuild Jezero data from raw NASA / USGS sources...", lambda: act_rebuild(False)),
            MenuAction("Full rebuild (also the Jezero 1 m DTMs)...", lambda: act_rebuild(True)),
            MenuSeparator(),
            MenuAction("Open the data folder", act_open_folder),
            MenuAction("Open saved reports", lambda: act_open_folder("reports")),
        ]),
        Menu("Help", [
            MenuAction("User guide (PDF)", act_guide),
            MenuAction("Engine status", act_status),
            MenuAction("Open the log folder", act_open_folder),
            MenuSeparator(),
            MenuAction("About MarsNav", act_about),
        ]),
    ]


# ------------------------------------------------------------------------------------------------ start and stop

def boot() -> None:
    """Runs once the window is up: start the map engine, then show the app."""
    sup = S["sup"]
    try:
        splash_status("Starting the map engine (the first start on a new computer can take a minute)...")
        if not sup.start():
            sup.kill()
            splash_error("The map engine did not start.\n\nDetails are in the log files in\n"
                         f"{S['root'] / 'data_cache'}\n(server.log and server_child.log).\n\n"
                         "Close this window and start MarsNav again; if it keeps happening, restart the computer.")
            return
        threading.Thread(target=sup.monitor, daemon=True, name="supervisor").start()
        MM.server_log(f"supervisor: server child running on port {S['port']} (desktop window, pid {os.getpid()})")
        with contextlib.suppress(OSError):
            (S["root"] / "data_cache" / "server.json").write_text(json.dumps(
                {"port": S["port"], "url": S["url"], "pid": os.getpid(), "health_port": sup.health_port, "desktop": True}))
        splash_status("Loading the map...")
        page = S["state"].get("page") or "/"
        if not re.match(r"^/[\w./#%,+-]*$", page) or page.startswith("//"):
            page = "/"
        S["booted"] = True
        S["main"].load_url(S["url"].rstrip("/") + page)
        log(f"window showing {page}")
    except Exception:  # noqa: BLE001
        log(f"start-up failed:\n{traceback.format_exc()}")
        splash_error("MarsNav hit an unexpected error while starting:\n\n" + traceback.format_exc()[-1500:])


def on_loaded() -> None:
    js = S.pop("pending_js", None)
    S["pending_js"] = None
    if js:
        with contextlib.suppress(Exception):
            S["main"].evaluate_js(js)


def local_download_running() -> bool:
    if not S["booted"] or not S["port"]:
        return False
    with contextlib.suppress(Exception):
        st, body = MM.http_get(S["port"], "/api/local/status", 3.0)
        if st == 200:
            p = (json.loads(body.decode()) or {}).get("progress") or {}
            return bool(p.get("running"))
    return False


def on_closing():
    """Closing the main window: offer to keep a running Local mode download going; then close everything."""
    if S["quitting"]:
        return True
    if local_download_running():
        if message_box("A Local mode download is still running.\n\nQuit anyway? It continues from where it stopped "
                       "the next time you start the download.", TITLE, 0x34) != 6:
            return False
    S["quitting"] = True
    w = S["main"]
    with contextlib.suppress(Exception):
        u = w.get_current_url() or ""
        if u.startswith(S["url"] or "\0"):
            S["state"]["page"] = "/" + u[len(S["url"]):].lstrip("/")
    save_state()
    import webview
    for other in list(webview.windows):
        if other is not w:
            with contextlib.suppress(Exception):
                other.destroy()
    return True


def _track_geometry(w) -> None:
    st = S["state"]

    def resized(width, height):
        if not st.get("maximized"):
            st["width"], st["height"] = int(width), int(height)

    def moved(x, y):
        if not st.get("maximized"):
            st["x"], st["y"] = int(x), int(y)

    with contextlib.suppress(Exception):
        w.events.resized += resized
        w.events.moved += moved
        w.events.maximized += lambda: st.__setitem__("maximized", True)
        w.events.restored += lambda: st.__setitem__("maximized", False)


def run_fallback(root: Path, sup, url: str) -> None:
    """No WebView2: Edge or Chrome as a plain app window (no tabs, no address bar), else the default browser."""
    log("WebView2 not found: using the app-mode fallback")
    if not sup.start():
        sup.kill()
        message_box("The map engine did not start. See server.log in\n" + str(root / "data_cache"), TITLE, 0x10)
        return
    threading.Thread(target=sup.monitor, daemon=True, name="supervisor").start()
    br = find_app_browser()
    try:
        if br:
            prof = root / "data_cache" / "appwindow"
            p = subprocess.Popen([br, f"--app={url}", f"--user-data-dir={prof}", "--no-first-run",
                                  "--no-default-browser-check", "--window-size=1440,900"], stdin=subprocess.DEVNULL)
            p.wait()
        else:
            webbrowser.open(url)
            message_box("MarsNav is open in your web browser.\n\nKeep this message open while you use it; "
                        "click OK to stop MarsNav.")
    finally:
        sup.stopping = True
        sup.kill()


def run(mm, args) -> None:
    """The desktop app (default when MarsNav.exe is double-clicked)."""
    global MM
    MM = mm
    root = mm.project_root()
    S["root"] = root
    if mm.find_app_dir(root) is None:
        message_box("MarsNav cannot find its 'app' folder.\n\nKeep MarsNav.exe together with the other files "
                    f"and folders it came with (app, planet, pipeline, MarsNav_runtime).\n\nLooked in: {root}",
                    TITLE, 0x10)
        return
    try:                                                 # the data folder must be writable (not e.g. Program Files)
        (root / "data_cache").mkdir(exist_ok=True)
        t = root / "data_cache" / ".write_test"
        t.write_text("ok")
        t.unlink()
    except OSError as e:
        message_box("MarsNav cannot save data in its folder:\n" + str(root) + f"\n({e})\n\n"
                    "Copy the whole MarsNav folder to a place where you can save files - your Desktop, "
                    "Documents, or another drive such as D:\\ - and start it from there.", TITLE, 0x10)
        return
    mm._LOG["path"] = root / "data_cache" / "server.log"
    redirect_std(root)

    mutex = mm.single_instance_name(root, args.dev)
    if not mm.single_instance(mutex):
        if not focus_existing():
            message_box("MarsNav is already running.")
        return
    mm.end_stale_processes()

    port = mm.free_port(args.port)
    S.update(port=port, url=f"http://127.0.0.1:{port}/", sup=mm.Supervisor(root, port, args.dev, quiet=True))
    S["state"] = load_state()
    mem = mm.sys_memory()
    mm.server_log(f"supervisor pid {os.getpid()} starting (desktop {VERSION}, {'exe' if mm.is_frozen() else 'source'}); "
                  f"memory {mem}; disk free: system drive {mm.disk_free_gb(mm.system_drive())} GB, "
                  f"program folder {mm.disk_free_gb(root)} GB; WebView2 {webview2_version()}")

    with contextlib.suppress(Exception):
        n = unblock_own_files(root)
        if n:
            log(f"removed the downloaded-from-the-internet mark from {n} program files")
    try:
        import webview
    except Exception:  # noqa: BLE001
        log(f"pywebview unavailable:\n{traceback.format_exc()}")
        run_fallback(root, S["sup"], S["url"])
        return
    if WIN and not webview2_version() and not (root / "MarsNav_runtime" / "WebView2").exists():
        run_fallback(root, S["sup"], S["url"])
        return

    st = S["state"]
    w_, h_ = int(st.get("width") or 1440), int(st.get("height") or 900)
    sw, sh = 1920, 1080
    if WIN:
        with contextlib.suppress(Exception):
            sw, sh = ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1)
    w_, h_ = max(1024, min(w_, sw)), max(680, min(h_, sh - 40))
    pos = {}
    if _on_screen(st.get("x"), st.get("y"), w_, h_):
        pos = {"x": int(st["x"]), "y": int(st["y"])}

    opts = [("ALLOW_DOWNLOADS", True), ("ALLOW_FILE_URLS", True), ("OPEN_EXTERNAL_LINKS_IN_BROWSER", True),
            ("OPEN_DEVTOOLS_IN_DEBUG", False), ("SHOW_DEFAULT_MENUS", False)]
    dbg = getattr(args, "debug_port", 0) or (int(os.environ["MM_DEBUG_PORT"]) if os.environ.get("MM_DEBUG_PORT", "").isdigit() else 0)
    if dbg:                                            # testing: Chrome DevTools protocol on this port (localhost only)
        opts.append(("REMOTE_DEBUGGING_PORT", int(dbg)))
    fixed = root / "MarsNav_runtime" / "WebView2"   # optional: a bundled fixed-version WebView2 runtime
    if fixed.exists():
        opts.append(("WEBVIEW2_RUNTIME_PATH", str(fixed)))
    for k, v in opts:
        with contextlib.suppress(Exception):
            webview.settings[k] = v

    import inspect
    kw = dict(width=w_, height=h_, min_size=(1024, 680), html=splash_html(root), js_api=Bridge(), text_select=True, zoomable=True,
              background_color="#0b0d10", maximized=bool(st.get("maximized")), **pos)
    params = inspect.signature(webview.create_window).parameters
    menu = None
    with contextlib.suppress(Exception):
        menu = build_menu()
    if menu and "menu" in params:
        kw["menu"] = menu
    kw = {k: v for k, v in kw.items() if k in params}
    win = webview.create_window(TITLE, **kw)
    S["main"] = win
    win.events.loaded += on_loaded
    win.events.closing += on_closing
    _track_geometry(win)
    theme_window(win)

    start_kw = dict(private_mode=False, storage_path=str(root / "data_cache" / "webview"), debug=bool(args.dev))
    sparams = inspect.signature(webview.start).parameters
    if menu and "menu" not in params and "menu" in sparams:
        start_kw["menu"] = menu
    if WIN and "gui" in sparams:
        start_kw["gui"] = "edgechromium"
    start_kw = {k: v for k, v in start_kw.items() if k in sparams}
    try:
        webview.start(boot, **start_kw)
    except Exception:  # noqa: BLE001 - the window could not be created at all: fall back to an app-mode window
        log(f"native window failed:\n{traceback.format_exc()}")
        if not S["booted"]:
            S["sup"].kill()
            run_fallback(root, S["sup"], S["url"])
            return
    finally:
        save_state()
    log("window closed: stopping the map engine")
    S["sup"].stopping = True
    S["sup"].kill()
