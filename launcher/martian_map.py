#!/usr/bin/env python3
"""
MarsNav -- all-in-one launcher.

Double-click MarsNav.exe (or run this file with Python 3.10+) and it will:
  1. Serve the app/ folder, the whole-planet tile stream and the planet API over HTTP on this machine (private to it).
  2. Show the app in its own native window (launcher/desktop.py: Microsoft Edge WebView2, no browser).
  3. Optionally rebuild every Mars data product from the raw NASA / USGS sources (Data menu).

  MarsNav.exe --console    the old text menu, opening the app in the default browser
  MarsNav.exe --headless   serve only (development, tests); MarsNav.exe --selftest   end-to-end server check

Process model (rebuilt from the ground up; tools/trace_root_cause.py reproduces every failure it is designed against):

  MarsNav.exe                      the app window, the "supervisor": keeps the server alive, never imports numpy.
  +- MarsNav.exe --serve-child     the web server. It and everything it starts live in a Windows job object, so no
     |                                process can outlive this window or survive a restart.
     +- MarsNav.exe --worker       1-3 raster readers (GDAL over HTTP), over a private localhost socket
     +- MarsNav.exe --run-job      routes, site builds, data rebuilds, offline pre-caching (log to a file)

Rules that keep it alive (each one fixes a failure that was traced on the target laptop):
  1. No process has a pipe on its standard handles. A thread blocked reading a stdin pipe makes every DLL load in any
     other thread of that process hang forever (numpy issue #24290; the v12 server hung inside "import numpy" this way,
     and the supervisor restarted it every 27 s).
  2. OpenBLAS is limited to one thread in every process: numpy + scipy otherwise commit ~32 MB per CPU each at import
     (measured: 790 MB per process on 12 CPUs, 84 MB with one thread). Server + workers + a job exhausted the Windows
     commit limit (MemoryError, threads that never start, "stack overflow").
  3. Every native library the server uses is imported on the main thread before any other thread exists.
  4. A fixed pool of long-lived request threads with a bounded queue (no thread churn), and requests whose browser has
     gone away stop waiting for raster workers.
  5. The supervisor watches a separate health port that reports real progress, gives a stalled server 30-60 s, and
     restarts it by terminating its job object: every process at once, nothing orphaned.

This file is also the entry point used to build MarsNav.exe (see build_exe.bat in the project root).
"""
from __future__ import annotations

import os

# Rule 2 -- before anything can import numpy / scipy, in this process and (inherited) in every process it starts.
for _k in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "GOTO_NUM_THREADS", "NUMEXPR_NUM_THREADS",
           "VECLIB_MAXIMUM_THREADS"):
    os.environ[_k] = "1"

import contextlib  # noqa: E402
import faulthandler  # noqa: E402
import hashlib  # noqa: E402
import http.server  # noqa: E402
import json  # noqa: E402
import mimetypes  # noqa: E402
import queue  # noqa: E402
import random  # noqa: E402
import select  # noqa: E402
import socket  # noqa: E402
import socketserver  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
import webbrowser  # noqa: E402
from pathlib import Path  # noqa: E402

APP_NAME = "MarsNav"
DEFAULT_PORT = 8765
WIN = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000
CREATE_SUSPENDED = 0x00000004


# =========================================================================== paths

def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def exe_dir() -> Path:
    """Folder the running .exe (or this .py file) lives in."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def project_root() -> Path:
    """The MarsNav project folder (contains app/, pipeline/, planet/ ...). MarsNav.exe sits directly in it."""
    env = os.environ.get("MM_ROOT")
    if env and (Path(env) / "app" / "index.html").exists():
        return Path(env)
    here = exe_dir()
    for c in (here, here.parent, here / "MarsNav", here / "MartianMap"):
        if (c / "app" / "index.html").exists():
            return c
    return here


def find_app_dir(root: Path) -> Path | None:
    for c in (root / "app", root / "MarsNav" / "app", root / "MartianMap" / "app"):
        if (c / "index.html").exists():
            return c
    return None


def self_cmd(*extra) -> list:
    """Command line that runs this launcher again (the exe itself when frozen) with extra arguments."""
    if is_frozen():
        return [sys.executable, *extra]
    return [sys.executable, "-u", str(Path(__file__).resolve()), *extra]


_LOG = {"path": None}
_LOG_LOCK = threading.Lock()


def server_log(msg: str) -> None:
    """Append to data_cache/server.log (the console of a double-clicked exe is not a place anyone can read later)."""
    p = _LOG["path"]
    if not p:
        return
    with _LOG_LOCK:
        try:
            if p.exists() and p.stat().st_size > 5_000_000:
                p.replace(p.with_suffix(".old.log"))
            with open(p, "a", encoding="utf-8") as f:
                f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + f"[{os.getpid()}] " + msg.rstrip() + "\n")
        except OSError:
            pass


# =========================================================================== Windows: job objects, processes, memory

if WIN:
    import ctypes
    from ctypes import wintypes as wt

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _psapi = ctypes.WinDLL("psapi", use_last_error=True)
    _ntdll = ctypes.WinDLL("ntdll")

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                       "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _JOB_BASIC_LIMITS(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wt.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wt.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wt.DWORD), ("SchedulingClass", wt.DWORD)]

    class _JOB_EXTENDED_LIMITS(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", _JOB_BASIC_LIMITS), ("IoInfo", _IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    class _JOB_PID_LIST(ctypes.Structure):
        _fields_ = [("NumberOfAssignedProcesses", wt.DWORD), ("NumberOfProcessIdsInList", wt.DWORD),
                    ("ProcessIdList", ctypes.c_size_t * 512)]

    class _MEMSTAT(ctypes.Structure):
        _fields_ = [("dwLength", wt.DWORD), ("dwMemoryLoad", wt.DWORD), ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    class _PMC(ctypes.Structure):
        _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t)]

    class _PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                    ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]

    class _THREADENTRY32(ctypes.Structure):
        _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ThreadID", wt.DWORD),
                    ("th32OwnerProcessID", wt.DWORD), ("tpBasePri", ctypes.c_long), ("tpDeltaPri", ctypes.c_long),
                    ("dwFlags", wt.DWORD)]

    def _proto(fn, res, *args):
        fn.restype = res
        fn.argtypes = list(args)

    _proto(_k32.CreateJobObjectW, wt.HANDLE, ctypes.c_void_p, wt.LPCWSTR)
    _proto(_k32.SetInformationJobObject, wt.BOOL, wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD)
    _proto(_k32.QueryInformationJobObject, wt.BOOL, wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD,
           ctypes.POINTER(wt.DWORD))
    _proto(_k32.AssignProcessToJobObject, wt.BOOL, wt.HANDLE, wt.HANDLE)
    _proto(_k32.TerminateJobObject, wt.BOOL, wt.HANDLE, wt.UINT)
    _proto(_k32.CloseHandle, wt.BOOL, wt.HANDLE)
    _proto(_k32.OpenProcess, wt.HANDLE, wt.DWORD, wt.BOOL, wt.DWORD)
    _proto(_k32.OpenThread, wt.HANDLE, wt.DWORD, wt.BOOL, wt.DWORD)
    _proto(_k32.ResumeThread, wt.DWORD, wt.HANDLE)
    _proto(_k32.TerminateProcess, wt.BOOL, wt.HANDLE, wt.UINT)
    _proto(_k32.WaitForSingleObject, wt.DWORD, wt.HANDLE, wt.DWORD)
    _proto(_k32.GetCurrentProcess, wt.HANDLE)
    _proto(_k32.GlobalMemoryStatusEx, wt.BOOL, ctypes.POINTER(_MEMSTAT))
    _proto(_k32.CreateToolhelp32Snapshot, wt.HANDLE, wt.DWORD, wt.DWORD)
    _proto(_k32.Process32FirstW, wt.BOOL, wt.HANDLE, ctypes.POINTER(_PROCESSENTRY32W))
    _proto(_k32.Process32NextW, wt.BOOL, wt.HANDLE, ctypes.POINTER(_PROCESSENTRY32W))
    _proto(_k32.Thread32First, wt.BOOL, wt.HANDLE, ctypes.POINTER(_THREADENTRY32))
    _proto(_k32.Thread32Next, wt.BOOL, wt.HANDLE, ctypes.POINTER(_THREADENTRY32))
    _proto(_k32.QueryFullProcessImageNameW, wt.BOOL, wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD))
    _proto(_k32.GetStdHandle, wt.HANDLE, wt.DWORD)
    _proto(_k32.GetFileType, wt.DWORD, wt.HANDLE)
    _proto(_k32.CreateMutexW, wt.HANDLE, ctypes.c_void_p, wt.BOOL, wt.LPCWSTR)
    _proto(_ntdll.NtResumeProcess, ctypes.c_long, wt.HANDLE)
    _proto(_psapi.GetProcessMemoryInfo, wt.BOOL, wt.HANDLE, ctypes.POINTER(_PMC), wt.DWORD)
    _INVALID = ctypes.c_void_p(-1).value

    class Job:
        """A Windows job object with KILL_ON_JOB_CLOSE: every process put in it, and every process those start, ends
        when kill() is called -- or when this program ends in any way, because Windows closes the handle then."""

        def __init__(self):
            self.h = _k32.CreateJobObjectW(None, None)            # not inheritable: only this process holds it
            if not self.h:
                raise OSError(ctypes.get_last_error(), "CreateJobObject failed")
            info = _JOB_EXTENDED_LIMITS()
            info.BasicLimitInformation.LimitFlags = 0x2000        # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not _k32.SetInformationJobObject(self.h, 9, ctypes.byref(info), ctypes.sizeof(info)):
                err = ctypes.get_last_error()
                _k32.CloseHandle(self.h)
                raise OSError(err, "SetInformationJobObject failed")

        def add(self, process_handle) -> bool:
            return bool(_k32.AssignProcessToJobObject(self.h, int(process_handle)))

        def pids(self) -> list:
            lst = _JOB_PID_LIST()
            _k32.QueryInformationJobObject(self.h, 3, ctypes.byref(lst), ctypes.sizeof(lst), None)
            return [int(lst.ProcessIdList[i]) for i in range(min(lst.NumberOfProcessIdsInList, 512))]

        def kill(self) -> None:
            if self.h:
                _k32.TerminateJobObject(self.h, 1)

        def close(self) -> None:
            if self.h:
                _k32.CloseHandle(self.h)
                self.h = None

    def resume_process(proc: subprocess.Popen) -> None:
        """Resume a process created with CREATE_SUSPENDED (Popen closes the thread handle, so resume by process)."""
        if _ntdll.NtResumeProcess(int(proc._handle)) == 0:
            return
        snap = _k32.CreateToolhelp32Snapshot(0x4, 0)                 # TH32CS_SNAPTHREAD
        if not snap or snap == _INVALID:
            return
        try:
            te = _THREADENTRY32()
            te.dwSize = ctypes.sizeof(te)
            ok = _k32.Thread32First(snap, ctypes.byref(te))
            while ok:
                if te.th32OwnerProcessID == proc.pid:
                    th = _k32.OpenThread(0x0002, False, te.th32ThreadID)   # THREAD_SUSPEND_RESUME
                    if th:
                        _k32.ResumeThread(th)
                        _k32.CloseHandle(th)
                ok = _k32.Thread32Next(snap, ctypes.byref(te))
        finally:
            _k32.CloseHandle(snap)

    def sys_memory() -> dict:
        ms = _MEMSTAT()
        ms.dwLength = ctypes.sizeof(ms)
        _k32.GlobalMemoryStatusEx(ctypes.byref(ms))
        M = 2 ** 20
        return {"ram_mb": ms.ullTotalPhys // M, "ram_free_mb": ms.ullAvailPhys // M, "load_pct": ms.dwMemoryLoad,
                "commit_limit_mb": ms.ullTotalPageFile // M, "commit_free_mb": ms.ullAvailPageFile // M}

    def private_mb(pid: int) -> float | None:
        h = _k32.OpenProcess(0x1000 | 0x0010, False, pid)           # QUERY_LIMITED_INFORMATION | VM_READ
        if not h:
            h = _k32.OpenProcess(0x1000, False, pid)
        if not h:
            return None
        try:
            pmc = _PMC()
            pmc.cb = ctypes.sizeof(pmc)
            if _psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):
                return round(pmc.PagefileUsage / 2 ** 20, 1)
        finally:
            _k32.CloseHandle(h)
        return None

    def process_table() -> dict:
        """{pid: (parent pid, exe name)} for every process."""
        out = {}
        snap = _k32.CreateToolhelp32Snapshot(0x2, 0)                 # TH32CS_SNAPPROCESS
        if not snap or snap == _INVALID:
            return out
        try:
            e = _PROCESSENTRY32W()
            e.dwSize = ctypes.sizeof(e)
            ok = _k32.Process32FirstW(snap, ctypes.byref(e))
            while ok:
                out[int(e.th32ProcessID)] = (int(e.th32ParentProcessID), e.szExeFile)
                ok = _k32.Process32NextW(snap, ctypes.byref(e))
        finally:
            _k32.CloseHandle(snap)
        return out

    def image_path(pid: int) -> str | None:
        h = _k32.OpenProcess(0x1000, False, pid)
        if not h:
            return None
        try:
            buf = ctypes.create_unicode_buffer(1024)
            n = wt.DWORD(1024)
            if _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                return buf.value
        finally:
            _k32.CloseHandle(h)
        return None

    def pid_alive(pid: int) -> bool:
        h = _k32.OpenProcess(0x00100000 | 0x1000, False, pid)        # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            return _k32.WaitForSingleObject(h, 0) == 0x102            # WAIT_TIMEOUT: still running
        finally:
            _k32.CloseHandle(h)

    def terminate_pid(pid: int) -> bool:
        h = _k32.OpenProcess(0x0001, False, pid)                     # PROCESS_TERMINATE
        if not h:
            return False
        try:
            return bool(_k32.TerminateProcess(h, 1))
        finally:
            _k32.CloseHandle(h)

    def std_handle_types() -> dict:
        """File type of this process's standard handles: 'pipe' is what rule 1 forbids."""
        names = {0: "unknown", 1: "file", 2: "char (console or NUL)", 3: "pipe"}
        out = {}
        for label, n in (("stdin", -10), ("stdout", -11), ("stderr", -12)):
            h = _k32.GetStdHandle(ctypes.c_ulong(n & 0xFFFFFFFF).value)
            out[label] = "none" if not h or h == _INVALID else names.get(_k32.GetFileType(h) & 0x7FFF, "?")
        return out

    _MUTEX = []

    def single_instance(name: str) -> bool:
        """True if this is the only running supervisor of this project folder (a named mutex; Windows releases it
        when the process ends, however it ends)."""
        h = _k32.CreateMutexW(None, False, name)
        already = ctypes.get_last_error() == 183                      # ERROR_ALREADY_EXISTS
        if h:
            _MUTEX.append(h)
        return not already
else:  # pragma: no cover - the app targets Windows; these keep it runnable elsewhere for development
    Job = None

    def resume_process(proc):
        pass

    def sys_memory() -> dict:
        try:
            pages, size = os.sysconf("SC_PHYS_PAGES"), os.sysconf("SC_PAGE_SIZE")
            avail = os.sysconf("SC_AVPHYS_PAGES")
            return {"ram_mb": pages * size // 2**20, "ram_free_mb": avail * size // 2**20, "load_pct": 0,
                    "commit_limit_mb": pages * size // 2**20, "commit_free_mb": avail * size // 2**20}
        except (ValueError, OSError, AttributeError):
            return {"commit_free_mb": 4096}

    def private_mb(pid):
        return None

    def process_table():
        return {}

    def image_path(pid):
        return None

    def pid_alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def terminate_pid(pid):
        with contextlib.suppress(OSError):
            os.kill(pid, 9)
            return True
        return False

    def std_handle_types():
        return {}

    def single_instance(name):
        return True


def disk_free_gb(path) -> float | None:
    import shutil
    try:
        return round(shutil.disk_usage(str(path)).free / 2 ** 30, 2)
    except OSError:
        return None


def system_drive() -> str:
    return (os.environ.get("SystemDrive") or "C:") + os.sep if WIN else "/"


def leftover_unpack_dirs() -> list:
    """Folders that older one-file builds of MarsNav.exe unpacked into the temp folder (216 MB each) and could not
    remove because the process was killed. [(path, bytes)] of the ones that are not in use."""
    import tempfile
    out = []
    tmp = Path(tempfile.gettempdir())
    mine = str(getattr(sys, "_MEIPASS", "") or "").lower()
    for d in tmp.glob("_MEI*"):
        try:
            if not d.is_dir() or str(d).lower() == mine or time.time() - d.stat().st_mtime < 600:
                continue
            ours = (d / "rasterio.libs").is_dir() or (d / "rasterio").is_dir()
            empty = not any(d.iterdir())
            if not (ours or empty):
                continue
            size = 0
            for r, _ds, fs in os.walk(d):
                for f in fs:
                    with contextlib.suppress(OSError):
                        size += os.path.getsize(os.path.join(r, f))
            out.append((d, size))
        except OSError:
            continue
    return out


def clean_leftovers(items: list) -> int:
    """Remove leftover unpack folders (asked for with menu option C). Files still in use are skipped."""
    import shutil
    freed = 0
    for d, size in items:
        shutil.rmtree(d, ignore_errors=True)
        if not d.exists():
            freed += size
    return freed


def watch_parent() -> None:
    """Child processes end when the process that started them ends (MM_PARENT_PID). Waits on the parent's process
    handle -- never on a pipe (rule 1). The job object already guarantees this on Windows; this covers the rest."""
    try:
        pid = int(os.environ.get("MM_PARENT_PID") or 0)
    except ValueError:
        pid = 0
    if not pid:
        return
    if WIN:
        h = _k32.OpenProcess(0x00100000, False, pid)                 # SYNCHRONIZE
        if not h:
            os._exit(0)

        def wait():
            _k32.WaitForSingleObject(h, 0xFFFFFFFF)
            os._exit(0)
    else:
        def wait():
            while True:
                time.sleep(2)
                if os.getppid() != pid:
                    os._exit(0)
    threading.Thread(target=wait, daemon=True, name="parent-watch").start()


# =========================================================================== HTTP server (the --serve-child process)

STATS = {"accepted": 0, "served": 0, "busy": 0, "rejected": 0, "cancelled": 0, "errors": 0, "last_dequeue": time.time(),
         "last_done": time.time(), "accepting": False, "started": time.time(), "threads": 0}
_STATS_LOCK = threading.Lock()
LATE_IMPORTS: list = []
_LATE_SEEN: set = set()
_PRELOAD = {"done": False, "seconds": None, "slowest": [], "count": 0, "failed": []}


def _stat(key: str, delta: int = 1) -> None:
    with _STATS_LOCK:
        STATS[key] += delta


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Serves app/ (static) plus the planet API (/api/...) and tile stream (/tiles/...)."""

    timeout = 60              # an idle / stalled client connection gives its thread back after this
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
                      ".svg": "image/svg+xml", ".css": "text/css", ".html": "text/html", ".png": "image/png",
                      ".jpg": "image/jpeg", ".pdf": "application/pdf", ".bin": "application/octet-stream",
                      ".mmd": "application/octet-stream"}
    root: Path = Path(".")
    dev = False

    def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
        if self.dev:
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        # Local server: always serve the files on disk right now (no stale caches after an update)
        if not getattr(self, "_mm_cache_set", False):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def copyfile(self, source, outputfile):
        # 64 KB at a time (shutil uses 1 MB buffers on Windows: a MemoryError when commit is short)
        while True:
            buf = source.read(65536)
            if not buf:
                break
            outputfile.write(buf)

    def _client_gone(self) -> bool:
        """True if the browser has closed this connection (HTTP/1.0 GET: nothing more should arrive on it)."""
        try:
            r, _, _ = select.select([self.connection], [], [], 0)
            if not r:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def _api(self, method: str) -> bool:
        path = self.path.split("?", 1)[0]
        if not (path.startswith("/api/") or path.startswith("/tiles/")):
            return False
        if path == "/api/ping":
            self._send(200, b'{"ok":true}', "application/json")
            return True
        if path == "/api/shutdown" and self.dev and self.client_address[0] in ("127.0.0.1", "::1"):
            self._send(200, b'{"ok":true,"bye":true}', "application/json")
            threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
            return True
        _reload_planet_if_changed(self.root)
        if path.startswith("/api/tss/"):
            # live suit telemetry: built-in TSS bridge (UDP <-> Server-Sent Events), no separate program to run
            self._mm_stream = path.endswith("/events")
            try:
                from planet import tss
                tss.handle(self, method, self.path, self.root)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception as exc:  # noqa: BLE001
                server_log(f"{method} {self.path} failed:\n{traceback.format_exc()}")
                with contextlib.suppress(OSError):
                    self._send(500, json.dumps({"ok": False, "error": str(exc)}).encode(), "application/json")
            return True
        from planet import api as planet_api
        body = b""
        if method == "POST":
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
        try:
            status, headers, payload = planet_api.handle(method, self.path, body, root=self.root, client_gone=self._client_gone)
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:  # noqa: BLE001
            if type(exc).__name__ == "Cancelled":        # the browser went away: nothing to send
                _stat("cancelled")
                self.close_connection = True
                return True
            _stat("errors")
            server_log(f"{method} {self.path} failed:\n{traceback.format_exc()}")
            status, headers, payload = 500, {"Content-Type": "application/json"}, json.dumps({"ok": False, "error": str(exc)}).encode()
        self._mm_cache_set = "Cache-Control" in headers
        try:
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            pass
        return True

    def _send(self, status, payload, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if not self._api("GET"):
            super().do_GET()

    def do_HEAD(self):
        if not self._api("HEAD"):
            super().do_HEAD()

    def do_POST(self):
        if not self._api("POST"):
            self.send_error(405)


_PLANET_MTIME = [0.0]
_RELOAD = {"lock": threading.Lock(), "checked": 0.0}


def _reload_planet_if_changed(root: Path) -> None:
    """Pick up edited planet/*.py and pipeline/*.py without restarting (the exe runs them from the project folder).
    Checked at most every 2 s."""
    now = time.time()
    if now - _RELOAD["checked"] < 2.0:
        return
    with _RELOAD["lock"]:
        if now - _RELOAD["checked"] < 2.0:
            return
        _RELOAD["checked"] = now
        files = list((root / "planet").glob("*.py")) + list((root / "pipeline").glob("*.py"))
        m = max((f.stat().st_mtime for f in files), default=0.0)
        if m <= _PLANET_MTIME[0]:
            return
        first = _PLANET_MTIME[0] == 0.0
        _PLANET_MTIME[0] = m
        if first:
            return
        stems = {f.stem for f in (root / "pipeline").glob("*.py")}
        for name in list(sys.modules):
            # planet.workers stays: the running worker pool (and its exception classes) must remain the same objects
            if (name == "planet" or name.startswith("planet.") or name in stems) and name != "planet.workers":
                del sys.modules[name]
        with contextlib.suppress(Exception):
            import planet.api  # noqa: F401  (re-import now, in one place, pure Python: numpy etc. stay loaded)
        server_log("planet/pipeline code changed on disk: reloaded")


class PooledHTTPServer(socketserver.TCPServer):
    """A fixed pool of long-lived request threads fed by a bounded queue. No thread is created per request (thread churn
    was one of the ways the old server met the Windows loader lock and memory pressure), and a flood of requests gets
    a quick 503 instead of unbounded threads."""

    allow_reuse_address = not WIN      # POSIX: rebind over TIME_WAIT at once; Windows: SO_EXCLUSIVEADDRUSE (below) instead
    request_queue_size = 128

    def __init__(self, addr, handler, threads: int = 48, backlog: int = 1024):
        self._q: queue.Queue = queue.Queue(maxsize=backlog)
        self.n_threads = threads
        self.active: dict = {}
        super().__init__(addr, handler)
        STATS["threads"] = threads
        for i in range(threads):
            threading.Thread(target=self._work, name=f"http-{i:02d}", daemon=True).start()

    def server_bind(self):
        if WIN and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def process_request(self, request, client_address):
        _stat("accepted")
        try:
            self._q.put_nowait((request, client_address))
        except queue.Full:
            _stat("rejected")
            with contextlib.suppress(OSError):
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nRetry-After: 2\r\nContent-Length: 0\r\n\r\n")
            self.shutdown_request(request)

    def _work(self):
        me = threading.get_ident()
        while True:
            request, client_address = self._q.get()
            STATS["last_dequeue"] = time.time()
            self.active[me] = time.time()
            _stat("busy")
            try:
                self.finish_request(request, client_address)
            except Exception:  # noqa: BLE001
                self.handle_error(request, client_address)
            finally:
                with contextlib.suppress(Exception):
                    self.shutdown_request(request)
                self.active.pop(me, None)
                _stat("busy", -1)
                _stat("served")
                STATS["last_done"] = time.time()

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, socket.timeout)):
            return
        _stat("errors")
        server_log(f"request from {client_address} failed:\n{traceback.format_exc()}")

    def queued(self) -> int:
        return self._q.qsize()


def server_info(httpd: PooledHTTPServer | None = None) -> dict:
    now = time.time()
    h = httpd or _SERVER.get("httpd")
    q = h.queued() if h else 0
    oldest = min(list(h.active.values()), default=None) if h else None
    stalled = (not STATS["accepting"]) or (q > 0 and now - STATS["last_dequeue"] > 60)
    wk = {}
    p = getattr(sys, "_martian_map_workers", None)
    if p is not None:
        with contextlib.suppress(Exception):
            wk = p.status()
    return {"ok": not stalled, "stalled": stalled, "pid": os.getpid(), "uptime_s": round(now - STATS["started"]),
            "threads": STATS["threads"], "busy": STATS["busy"], "queued": q, "accepted": STATS["accepted"],
            "served": STATS["served"], "rejected": STATS["rejected"], "cancelled": STATS["cancelled"], "errors": STATS["errors"],
            "oldest_active_s": round(now - oldest, 1) if oldest else 0.0, "idle_s": round(now - STATS["last_done"], 1),
            "accepting": STATS["accepting"], "workers": wk, "private_mb": private_mb(os.getpid()), "memory": sys_memory(),
            "preload": _PRELOAD, "std_handles": _SERVER.get("std"), "late_imports": LATE_IMPORTS[-40:],
            "python_threads": threading.active_count(), "frozen": is_frozen(),
            "openblas_threads": os.environ.get("OPENBLAS_NUM_THREADS")}


_SERVER: dict = {}


class Health:
    """A second, single-threaded listener on its own port for the supervisor. It answers even when every request thread
    is busy, and it reports whether requests are actually being picked up (stalled = work waiting, none taken for 60 s).
    It also re-arms a C-level faulthandler timer: if this thread cannot run for 45 s (the interpreter itself is stuck),
    every thread's stack is written to data_cache/server_hang.log."""

    def __init__(self, port: int, root: Path, hang_f):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if WIN and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        self.sock.bind(("127.0.0.1", port))
        self.sock.listen(8)
        self.sock.settimeout(5)
        self.root, self.hang_f = root, hang_f
        self.last_dump = 0.0
        self.logged_late = 0

    def run(self):
        while True:
            with contextlib.suppress(Exception):
                faulthandler.cancel_dump_traceback_later()
                faulthandler.dump_traceback_later(45, repeat=False, file=self.hang_f)
            info = None
            try:
                info = server_info()
                if info["stalled"] and time.time() - self.last_dump > 300:
                    self.last_dump = time.time()
                    self._dump("requests are waiting but none was picked up for 60 s")
                if len(LATE_IMPORTS) > self.logged_late:
                    new = LATE_IMPORTS[self.logged_late:]
                    self.logged_late = len(LATE_IMPORTS)
                    server_log("modules imported by request threads after start-up: " +
                               ", ".join(f"{m} ({t})" for _ts, t, m in new[:20]))
            except Exception:  # noqa: BLE001
                server_log(f"health: {traceback.format_exc()}")
            try:
                conn, _addr = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                time.sleep(1)
                continue
            with conn:
                try:
                    conn.settimeout(2)
                    with contextlib.suppress(OSError):
                        conn.recv(2048)
                    body = json.dumps(info or server_info(), default=str).encode()
                    conn.sendall(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
                except Exception:  # noqa: BLE001
                    pass

    def _dump(self, why: str):
        try:
            f = self.hang_f
            f.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} pid {os.getpid()}: {why}; {threading.active_count()} threads =====\n")
            names = {t.ident: t.name for t in threading.enumerate()}
            for tid, frame in sys._current_frames().items():
                f.write(f"\n--- {names.get(tid, tid)} ---\n{''.join(traceback.format_stack(frame))}")
            f.flush()
            server_log(f"server stalled ({why}): thread stacks written to data_cache/server_hang.log")
        except Exception:  # noqa: BLE001
            pass


PRELOAD_NATIVE = [
    "numpy", "scipy", "scipy.ndimage", "scipy.sparse", "scipy.special", "PIL", "PIL.Image", "PIL.JpegImagePlugin",
    "PIL.PngImagePlugin", "ssl", "hashlib", "zlib", "gzip", "bz2", "lzma", "uuid", "secrets", "pickle", "struct", "decimal",
    "urllib.request", "urllib.parse", "http.client", "email.parser", "concurrent.futures", "certifi", "ctypes", "select",
    "json", "csv", "io", "shutil", "tempfile", "zipfile", "unicodedata", "stringprep", "encodings.idna", "encodings.ascii",
    "encodings.latin_1", "encodings.cp1252", "encodings.utf_16", "mmap", "html", "xml.etree.ElementTree", "PIL.ImageMath",
    "PIL.ImageOps", "PIL.ImageFilter", "PIL.ImageDraw", "PIL.BmpImagePlugin", "PIL.GifImagePlugin", "PIL.PpmImagePlugin",
    "PIL.TiffImagePlugin",
]
PRELOAD_PLANET = [
    "planet", "planet.config", "planet.net", "planet.tiling", "planet.tilecache", "planet.catalog", "planet.megdr",
    "planet.names", "planet.workers", "planet.cog", "planet.jobs", "planet.dem", "planet.imagery", "planet.safety",
    "planet.landing", "planet.api", "planet.tss", "planet.datasets", "planet.assess",
]


def _bundle_hints() -> None:  # pragma: no cover - never called
    """Import statements PyInstaller can see: the preload lists name modules as strings, which its analysis cannot follow,
    so without these some would be missing from MarsNav.exe."""
    import bz2, csv, decimal, html, lzma, secrets, stringprep, tempfile, unicodedata, uuid, zipfile  # noqa: F401,E401
    import concurrent.futures, encodings.idna, encodings.ascii, encodings.latin_1, xml.etree.ElementTree  # noqa: F401,E401
    import encodings.cp1252, encodings.utf_16, mmap  # noqa: F401,E401
    import PIL.ImageMath, PIL.ImageOps, PIL.ImageFilter, PIL.ImageDraw, PIL.BmpImagePlugin, PIL.GifImagePlugin  # noqa: F401,E401
    import PIL.PpmImagePlugin, PIL.TiffImagePlugin  # noqa: F401,E401
    import numpy, scipy, scipy.ndimage, scipy.sparse, scipy.sparse.csgraph, scipy.special  # noqa: F401,E401
    import PIL.Image, PIL.JpegImagePlugin, PIL.PngImagePlugin  # noqa: F401,E401
    import rasterio, rasterio.warp, rasterio.windows, rasterio.crs, rasterio.enums, affine, certifi  # noqa: F401,E401


def preload(names: list) -> None:
    """Rule 3: import every native library on the main thread, before any other thread exists."""
    import importlib
    t0 = time.time()
    times = []
    for n in names:
        t = time.time()
        try:
            importlib.import_module(n)
        except Exception as e:  # noqa: BLE001 - optional module: note it and go on
            _PRELOAD["failed"].append(f"{n}: {type(e).__name__}: {e}")
        times.append((round(time.time() - t, 2), n))
    with contextlib.suppress(Exception):
        mimetypes.init()                          # reads the Windows registry: once, here, not in a request thread
    with contextlib.suppress(Exception):
        import PIL.Image
        PIL.Image.init()                          # Pillow loads every image plugin on the first open(): do it now
    _PRELOAD.update(done=True, seconds=round(time.time() - t0, 1), count=len(names),
                    slowest=[f"{n} {s}s" for s, n in sorted(times, reverse=True)[:5]])


def _audit(event, args):
    # modules first imported by a request thread after start-up (each such native import is a DLL load under load)
    if event == "import" and _PRELOAD["done"] and threading.current_thread() is not threading.main_thread():
        name = args[0] if args else "?"
        if name not in _LATE_SEEN and len(_LATE_SEEN) < 500:
            _LATE_SEEN.add(name)
            LATE_IMPORTS.append((time.strftime("%H:%M:%S"), threading.current_thread().name, name))


def workers_for_memory() -> int:
    """Raster workers this machine can afford: ~200 MB of commit each at worst (imports 84 MB, GDAL block cache 64 MB,
    HTTP cache 64 MB), keeping 700 MB of the commit limit free for everything else."""
    free = sys_memory().get("commit_free_mb", 4096)
    return int(max(1, min(3, (free - 700) // 200)))


def serve_child(args) -> None:
    """The web server process (started by the supervisor inside its job object)."""
    root = project_root()
    app_dir = find_app_dir(root)
    (root / "data_cache").mkdir(exist_ok=True)
    _LOG["path"] = root / "data_cache" / "server.log"
    hang_f = open(root / "data_cache" / "server_hang.log", "a", encoding="utf-8")
    faulthandler.enable(file=hang_f)                  # a hard crash leaves every thread's stack here
    faulthandler.dump_traceback_later(240, repeat=False, file=hang_f)   # ... and so does a start-up that hangs
    _SERVER["std"] = std_handle_types()               # checked before any thread exists (rule 1)
    os.environ.update({"MM_ROOT": str(root), "MM_RUN_JOB": "1", "MM_WORKERS": "1",
                       "MM_WORKERS_MAX": str(workers_for_memory())})
    for pth in (str(root / "pipeline"), str(root)):
        if pth not in sys.path:
            sys.path.insert(0, pth)
    from planet import config                          # (pure Python: paths only)
    config.configure(root)
    preload(PRELOAD_NATIVE + PRELOAD_PLANET)
    faulthandler.cancel_dump_traceback_later()
    sys.addaudithook(_audit)
    _PLANET_MTIME[0] = max((f.stat().st_mtime for f in list((root / "planet").glob("*.py")) +
                            list((root / "pipeline").glob("*.py"))), default=1.0)
    mem = sys_memory()
    server_log(f"server child starting: preloaded {_PRELOAD['count']} modules in {_PRELOAD['seconds']} s "
               f"(slowest {', '.join(_PRELOAD['slowest'][:3])}); std handles {_SERVER['std']}; "
               f"OPENBLAS_NUM_THREADS={os.environ.get('OPENBLAS_NUM_THREADS')}; raster workers up to {os.environ['MM_WORKERS_MAX']}; "
               f"private {private_mb(os.getpid())} MB; commit free {mem.get('commit_free_mb')} of {mem.get('commit_limit_mb')} MB"
               + (f"; import failures: {_PRELOAD['failed']}" if _PRELOAD["failed"] else ""))
    watch_parent()

    class Handler(QuietHandler):
        pass
    Handler.root = root
    Handler.dev = args.dev

    def handler_factory(*a, **kw):
        return Handler(*a, directory=str(app_dir), **kw)

    httpd = None
    for _ in range(60):                                # the previous server's port may take a moment to be released
        try:
            httpd = PooledHTTPServer(("127.0.0.1", args.port), handler_factory, threads=48)
            break
        except OSError:
            time.sleep(0.5)
    if httpd is None:
        server_log(f"server child could not bind port {args.port}")
        sys.exit(2)
    _SERVER["httpd"] = httpd
    sys._martian_map_server_info = server_info

    def serve():
        STATS["accepting"] = True
        try:
            httpd.serve_forever(poll_interval=0.5)
        except BaseException:  # noqa: BLE001
            server_log(f"serve_forever stopped:\n{traceback.format_exc()}")
        finally:
            STATS["accepting"] = False
    threading.Thread(target=serve, daemon=True, name="http-accept").start()
    if args.health_port:
        health = Health(args.health_port, root, hang_f)
        threading.Thread(target=health.run, daemon=True, name="health").start()
    server_log(f"server child ready on port {args.port} (health port {args.health_port}, dev={args.dev})")
    try:
        from planet import api as planet_api
        planet_api.startup(root)
    except Exception:  # noqa: BLE001
        server_log(f"planet start-up failed:\n{traceback.format_exc()}")
    while True:
        time.sleep(3600)


# =========================================================================== worker and job processes

def run_worker(argv: list) -> int:
    """A raster-reading worker process (planet/workers.py). Single-threaded apart from the parent watch."""
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--connect", type=int, required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--nonce", type=int, default=0)
    a = ap.parse_args(argv)
    root = project_root()
    os.environ["MM_ROOT"] = str(root)
    os.environ["MM_IN_WORKER"] = "1"
    for pth in (str(root / "pipeline"), str(root)):
        if pth not in sys.path:
            sys.path.insert(0, pth)
    hang_f = open(root / "data_cache" / "workers_hang.log", "a", encoding="utf-8")
    faulthandler.enable(file=hang_f)
    watch_parent()
    import importlib
    for n in ("numpy", "rasterio", "rasterio.warp", "rasterio.windows", "rasterio.crs", "rasterio.enums", "affine",
              "planet.config", "planet.net", "planet.cog", "planet.workers"):
        importlib.import_module(n)
    from planet import config, net, workers
    config.configure(root)
    for k, v in net.GDAL_ENV.items():                 # the same bounded GDAL settings for every use in this process
        os.environ[k] = str(v)
    return workers.worker_main(a.connect, a.token, a.nonce)


def run_job(payload: str) -> int:
    """Process for a long job started by the server (planet/jobs.py start_process): run one planet/pipeline function,
    print its log (to a file), finish with '@@RESULT <json>'. Never starts a server or opens a window."""
    root = project_root()
    os.environ["MM_ROOT"] = str(root)
    for pth in (str(root / "pipeline"), str(root)):
        if pth not in sys.path:
            sys.path.insert(0, pth)
    watch_parent()
    try:
        spec = json.loads(payload)
        from planet import config
        config.configure(root)
        import importlib
        mod, name = spec["fn"].split(":")
        fn = getattr(importlib.import_module(mod), name)
        result = fn(*spec.get("args", []), log=lambda m: print(m, flush=True), **spec.get("kwargs", {}))
        print("@@RESULT " + json.dumps(result, default=str), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        print(f"@@ERROR {type(exc).__name__}: {exc}", flush=True)
        return 1


# =========================================================================== supervisor (this window)

def free_port(preferred: int) -> int:
    for port in range(preferred, preferred + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return ephemeral_port()


def ephemeral_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http_get(port: int, path: str, timeout: float = 6.0) -> tuple[int, bytes]:
    """A plain HTTP/1.0 GET over a socket (no proxies, no urllib): (status, body); status 0 when no answer."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
            s.settimeout(timeout)
            s.sendall(f"GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n".encode())
            data = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
        head, _, body = data.partition(b"\r\n\r\n")
        parts = head.split(b" ", 2)
        return (int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0), body
    except (OSError, ValueError):
        return 0, b""


def raw_ping(port: int, timeout: float = 6.0) -> bool:
    return http_get(port, "/api/ping", timeout)[0] == 200


class Supervisor:
    """Runs the server as a child process inside a job object and keeps it alive."""

    GRACE_NO_ANSWER = 60.0     # s without any answer from the health port before a restart
    GRACE_STALLED = 30.0       # s of "stalled" reports (work waiting, none taken) before a restart
    START_TIMEOUT = 300.0      # s for a start (first start of a fresh exe: unpacking + antivirus scanning of the DLLs)
    MEMORY_CEILING_MB = 3500   # the server and everything it started, together

    def __init__(self, root: Path, port: int, dev: bool, quiet: bool = False):
        self.root, self.port, self.dev, self.quiet = root, port, dev, quiet
        self.proc = None
        self.job = None
        self.health_port = None
        self.restarts: list = []
        self.stopping = False
        self.last_health: dict = {}
        self.census = {"t": 0.0, "total": 0.0, "logged": 0.0, "peak": 0.0}
        self.lock = threading.Lock()

    def say(self, msg: str) -> None:
        if not self.quiet:
            print(msg, flush=True)

    def start(self) -> bool:
        self.health_port = ephemeral_port()
        env = {**os.environ, "MM_ROOT": str(self.root), "PYTHONIOENCODING": "utf-8", "MM_PARENT_PID": str(os.getpid())}
        tmp = self.root / "data_cache" / "tmp"          # temporary files on the project drive, not the system drive
        with contextlib.suppress(OSError):
            tmp.mkdir(parents=True, exist_ok=True)
            env["TMP"] = env["TEMP"] = str(tmp)
        env.pop("MM_WORKERS", None)
        env.pop("MM_IN_WORKER", None)
        cmd = self_cmd("--serve-child", "--port", str(self.port), "--health-port", str(self.health_port),
                       *(["--dev"] if self.dev else []))
        job = None
        if WIN:
            try:
                job = Job()
            except OSError as e:
                server_log(f"supervisor: no job object ({e}); falling back to tree kill")
        logf = open(self.root / "data_cache" / "server_child.log", "ab")
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=logf, stderr=logf, env=env, cwd=str(self.root),
                                         creationflags=(CREATE_NO_WINDOW | (CREATE_SUSPENDED if job else 0)) if WIN else 0)
        finally:
            logf.close()
        if job:
            if not job.add(self.proc._handle):
                server_log(f"supervisor: could not put the server in a job object (error {ctypes.get_last_error()})")
            resume_process(self.proc)
        self.job = job
        t0 = time.time()
        while time.time() - t0 < self.START_TIMEOUT:
            if self.proc.poll() is not None:
                server_log(f"supervisor: server child exited during start (code {self.proc.returncode})")
                return False
            h = self.health(2.0)
            if h and h.get("ok"):
                self.last_health = h
                server_log(f"supervisor: server child pid {self.proc.pid} healthy after {time.time() - t0:.1f} s "
                           f"(preload {h.get('preload', {}).get('seconds')} s)")
                return True
            time.sleep(0.5)
        server_log("supervisor: server child did not become healthy in time")
        return False

    def health(self, timeout: float = 5.0) -> dict | None:
        if not self.health_port:
            return None
        st, body = http_get(self.health_port, "/health", timeout)
        if st != 200:
            return None
        try:
            return json.loads(body.decode())
        except ValueError:
            return None

    def kill(self) -> None:
        """End the server and everything it started."""
        with self.lock:
            if self.job:
                self.job.kill()
                self.job.close()
                self.job = None
            elif self.proc and self.proc.poll() is None:
                if WIN:
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], capture_output=True,
                                   stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
                else:
                    self.proc.kill()
            if self.proc:
                with contextlib.suppress(Exception):
                    self.proc.wait(15)

    def job_census(self) -> dict:
        pids = self.job.pids() if self.job else ([self.proc.pid] if self.proc else [])
        per = {pid: private_mb(pid) for pid in pids}
        total = round(sum(v for v in per.values() if v), 1)
        self.census.update(t=time.time(), total=total, peak=max(self.census["peak"], total))
        return {"pids": pids, "private_mb": per, "total_mb": total, "memory": sys_memory()}

    def restart(self, why: str) -> None:
        now = time.time()
        self.restarts = [t for t in self.restarts if now - t < 600] + [now]
        server_log(f"supervisor: server {why}; restarting it (restart {len(self.restarts)} in 10 min)")
        self.say(f"\n  [the local server {why}: restarting it automatically]")
        self.kill()
        if len(self.restarts) >= 3:
            time.sleep(min(60, 10 * (len(self.restarts) - 2)))   # back off: something keeps failing, see server.log
        while not self.stopping:
            if self.start():
                server_log("supervisor: restart ok")
                return
            self.kill()
            server_log("supervisor: restart failed; trying again in 15 s")
            time.sleep(15)

    def monitor(self) -> None:
        bad_since = None
        while not self.stopping:
            time.sleep(5)
            if self.stopping:
                break
            dead = self.proc.poll() is not None
            h = None if dead else self.health(5.0)
            now = time.time()
            if h and h.get("ok"):
                if bad_since is not None:
                    server_log(f"supervisor: server answering again after {now - bad_since:.0f} s")
                bad_since = None
                self.last_health = h
            else:
                if bad_since is None:
                    bad_since = now
                    server_log(f"supervisor: health check {'process exited' if dead else ('stalled: ' + json.dumps({k: h.get(k) for k in ('busy', 'queued', 'oldest_active_s')}) if h else 'no answer')}")
                limit = 0 if dead else (self.GRACE_STALLED if h else self.GRACE_NO_ANSWER)
                if now - bad_since >= limit:
                    why = f"exited (code {self.proc.returncode})" if dead else ("stalled" if h else f"did not answer for {now - bad_since:.0f} s")
                    self.restart(why)
                    bad_since = None
                    continue
            if now - self.census["t"] >= 60:
                c = self.job_census()
                big_change = abs(c["total_mb"] - self.census.get("logged_total", 0)) > 300
                if big_change or now - self.census["logged"] >= 900 or c["memory"].get("commit_free_mb", 9999) < 500:
                    self.census["logged"] = now
                    self.census["logged_total"] = c["total_mb"]
                    server_log(f"census: {len(c['pids'])} processes, {c['total_mb']} MB private "
                               f"(peak {self.census['peak']}); commit free {c['memory'].get('commit_free_mb')} of "
                               f"{c['memory'].get('commit_limit_mb')} MB; per process {c['private_mb']}")
                if c["total_mb"] > self.MEMORY_CEILING_MB:
                    self.restart(f"used {c['total_mb']:.0f} MB (over {self.MEMORY_CEILING_MB} MB)")


# =========================================================================== data pipeline (menu R / F)

PIPELINE_STEPS_HELP = """\
Missing dependency: {exc}

This copy of MarsNav.exe could not bundle the full science data
pipeline. To rebuild the Mars data yourself, install Python 3.10+ from
https://www.python.org/downloads/ , then from the project folder run:

    pip install -r requirements.txt
    python pipeline\\fetch_data.py
    python pipeline\\build_terrain.py --site jezero
    python pipeline\\build_terrain.py --site jezero_east
    python pipeline\\build_layers.py --site jezero
    python pipeline\\fit_meda.py
    python pipeline\\build_layers.py --site jezero_east
    python pipeline\\build_imagery.py --site jezero
    python pipeline\\build_imagery.py --site jezero_east

(this is exactly what tools/build_all.sh does)
"""


def run_pipeline(root: Path, include_optional: bool = False) -> None:
    """Rebuild every Mars data product from the raw NASA / USGS rasters, in the same order as tools/build_all.sh."""
    pipeline_dir = root / "pipeline"
    if not pipeline_dir.exists():
        print(f"Can't find the pipeline/ folder next to this program ({root}).")
        return
    sys.path.insert(0, str(pipeline_dir))
    os.environ["MM_ROOT"] = str(root)
    print("\n=== Rebuilding Mars data from raw NASA / USGS sources ===")
    print("This can download up to ~0.9 GB and take about 10 minutes.\n")
    try:
        import numpy as np  # noqa: F401
        import scipy  # noqa: F401
        import rasterio  # noqa: F401
        import affine  # noqa: F401
        from PIL import Image  # noqa: F401

        import fetch_data
        import build_terrain
        import build_layers
        import build_imagery
        import fit_meda
        import sitecfg
    except ImportError as exc:
        print(PIPELINE_STEPS_HELP.format(exc=exc))
        return
    old_argv = sys.argv
    old_cwd = os.getcwd()
    try:
        os.chdir(str(root))
        print("--- fetch_data: downloading & verifying raw sources ---")
        sys.argv = ["fetch_data"] + (["--optional"] if include_optional else [])
        rc = fetch_data.main()
        if rc:
            print(f"fetch_data reported {rc} problem(s); continuing with what's cached.")
        sites = sitecfg.list_sites()
        print(f"\nSites: {', '.join(sites)}")
        for s in sites:
            print(f"\n--- build_terrain: {s} ---")
            build_terrain.main(sitecfg.load_site(s))
        print("\n--- build_layers: jezero (feeds the MEDA weather fit) ---")
        build_layers.main(sitecfg.load_site("jezero"))
        print("\n--- fit_meda: Jezero weather climatology ---")
        fit_meda.main()
        for s in sites:
            print(f"\n=== site {s} ===")
            print(f"--- build_layers: {s} ---")
            build_layers.main(sitecfg.load_site(s))
            print(f"--- build_imagery: {s} ---")
            build_imagery.main(sitecfg.load_site(s))
        print("\nData rebuild complete. Choose [O] to reload the app with the refreshed data.")
    except SystemExit as e:
        print(f"\nPipeline stopped: {e}")
    except Exception:
        print("\nThe data pipeline hit an error:")
        traceback.print_exc()
    finally:
        sys.argv = old_argv
        os.chdir(old_cwd)


# =========================================================================== self-test (MarsNav.exe --selftest)

def selftest(argv: list) -> int:
    """End-to-end check of the server exactly as the app runs it: start, load (tiles, API, static files, abandoned
    requests, a route job), kill a raster worker, kill the server itself, measure recovery, shut down, and verify that
    no process is left. Report: data_cache/selftest.txt."""
    duration = 150
    for a in argv:
        if a.startswith("--seconds="):
            duration = int(a.split("=", 1)[1])
    root = project_root()
    (root / "data_cache").mkdir(exist_ok=True)
    _LOG["path"] = root / "data_cache" / "server.log"
    out = root / "data_cache" / "selftest.txt"
    out.write_text("", encoding="utf-8")
    checks: list = []

    def rep(msg=""):
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        print(line, flush=True)
        with open(out, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def check(name, ok, detail=""):
        checks.append((name, bool(ok)))
        rep(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail else ''}")

    mem0 = sys_memory()
    rep(f"MarsNav self-test ({'MarsNav.exe' if is_frozen() else 'from source'}; Python {sys.version.split()[0]}; "
        f"{os.cpu_count()} CPUs; OPENBLAS_NUM_THREADS={os.environ.get('OPENBLAS_NUM_THREADS')})")
    rep(f"memory: {mem0}; disk free: system drive {disk_free_gb(system_drive())} GB, project {disk_free_gb(root)} GB")
    server_log("selftest: starting")
    port = free_port(8790)
    sup = Supervisor(root, port, dev=False, quiet=True)
    sup.GRACE_NO_ANSWER = 30.0
    t0 = time.time()
    ok = sup.start()
    t_start = time.time() - t0
    check("server starts and reports healthy", ok, f"{t_start:.1f} s")
    if not ok:
        tail = (root / "data_cache" / "server.log").read_text(encoding="utf-8", errors="replace").splitlines()[-15:]
        rep("server.log tail:\n    " + "\n    ".join(tail))
        sup.kill()
        return 1
    h = sup.health() or {}
    std = h.get("std_handles") or {}
    check("no pipe on the server's standard handles (rule 1)", "pipe" not in std.values(), json.dumps(std))
    check("OpenBLAS limited to one thread (rule 2)", h.get("openblas_threads") == "1", str(h.get("openblas_threads")))
    pre = h.get("preload") or {}
    check("native libraries preloaded on the main thread (rule 3)", pre.get("done") and not pre.get("failed"),
          f"{pre.get('count')} modules in {pre.get('seconds')} s, slowest {pre.get('slowest', [])[:3]}"
          + (f", failed {pre.get('failed')}" if pre.get("failed") else ""))
    rep(f"  server private memory after start: {h.get('private_mb')} MB; raster workers up to {h.get('workers', {}).get('max')}")

    # ---- load
    app_dir = find_app_dir(root)
    statics = ["/", "/index.html"] + [f"/{p.relative_to(app_dir).as_posix()}" for p in
                                       list((app_dir / "js").glob("*.js"))[:8] + list((app_dir / "css").glob("*.css"))[:3]]
    apis = ["/api/ping", "/api/planet/status", "/api/sites", "/api/safety/legend", "/api/search?q=Jezero"]
    rng = random.Random(7)

    def tile_url():
        z = rng.choice([2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 14])
        lon, lat = 77.45 + rng.uniform(-0.4, 0.4), 18.45 + rng.uniform(-0.4, 0.4)
        d = 180.0 / (1 << z)
        x, y = int((lon + 180) // d), int((90 - lat) // d)
        r = rng.random()
        if r < 0.45:
            return f"/tiles/dem/{z}/{y}/{x}.mmd"
        if r < 0.9:
            return f"/tiles/img/{z}/{y}/{x}.jpg?layer=best"
        return f"/tiles/img/{z}/{y}/{x}.jpg?layer=safety&lander=m2020"

    results: list = []
    errs: list = []
    samples: list = []
    stop = threading.Event()
    events: dict = {}

    def one(path, abandon=False):
        t = time.time()
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=90) as s:
                s.settimeout(90)
                s.sendall(f"GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n".encode())
                if abandon:
                    time.sleep(0.3)
                    return ("abandoned", 0, time.time() - t)
                data = b""
                while True:
                    c = s.recv(65536)
                    if not c:
                        break
                    data += c
            st = int(data.split(b" ", 2)[1]) if data.startswith(b"HTTP/") else 0
            if st >= 500 and len(errs) < 400:
                errs.append((path, st, data.partition(b"\r\n\r\n")[2][:240].decode("utf-8", "replace")))
            return ("tile" if path.startswith("/tiles/") else "api" if path.startswith("/api/") else "static", st, time.time() - t)
        except (OSError, ValueError, IndexError):
            time.sleep(0.2)                  # server down (the deliberate kill): do not spin
            return ("tile" if path.startswith("/tiles/") else "other", -1, time.time() - t)

    def loader():
        while not stop.is_set():
            r = rng.random()
            if r < 0.15:
                res = one(rng.choice(statics))
            elif r < 0.27:
                res = one(rng.choice(apis))
            elif r < 0.30:
                res = one(f"/api/point?lon={77.45 + rng.uniform(-0.2, 0.2):.4f}&lat={18.45 + rng.uniform(-0.2, 0.2):.4f}&z=12")
            else:
                res = one(tile_url(), abandon=rng.random() < 0.3)
            results.append((time.time() - t_load, *res))

    def sampler():
        while not stop.is_set():
            t = time.time()
            ok_main = raw_ping(port, 10)
            ping_ms = (time.time() - t) * 1000
            t = time.time()
            hh = sup.health(5)
            h_ms = (time.time() - t) * 1000
            c = sup.job_census()
            samples.append({"t": time.time() - t_load, "ping_ok": ok_main, "ping_ms": ping_ms, "health": bool(hh),
                            "health_ms": h_ms, "mb": c["total_mb"], "procs": len(c["pids"]),
                            "commit_free": c["memory"].get("commit_free_mb"), "queued": (hh or {}).get("queued"),
                            "busy": (hh or {}).get("busy")})
            stop.wait(2)

    rep(f"load: 8 clients for {duration} s (static files, API, map tiles around Jezero with 30% abandoned, a route job); "
        f"a raster worker is killed at 45 s and the server itself at {int(duration * 0.55)}-{int(duration * 0.8)} s "
        f"(once the route job is finished)")
    t_load = time.time()
    threads = [threading.Thread(target=loader, daemon=True) for _ in range(8)] + [threading.Thread(target=sampler, daemon=True)]
    for th in threads:
        th.start()
    mon = threading.Thread(target=sup.monitor, daemon=True, name="supervisor")
    mon.start()
    # a route job (in its own process), polled while the load runs
    route = {"status": None}

    def route_job():
        try:
            body = json.dumps({"points": [[77.40, 18.40], [77.52, 18.47]], "mode": "crewed_rover"}).encode()
            with socket.create_connection(("127.0.0.1", port), timeout=30) as s:
                s.sendall(b"POST /api/route HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: "
                          + str(len(body)).encode() + b"\r\n\r\n" + body)
                data = b""
                while True:
                    c = s.recv(65536)
                    if not c:
                        break
                    data += c
            jid = json.loads(data.partition(b"\r\n\r\n")[2])["job"]
            t = time.time()
            while time.time() - t < 240 and not stop.is_set():
                st, b = http_get(port, f"/api/job/{jid}", 10)
                if st == 200:
                    j = json.loads(b)
                    route["status"] = j.get("status")
                    route["elapsed"] = j.get("elapsed")
                    route["error"] = j.get("error")
                    if j.get("status") in ("done", "error"):
                        return
                time.sleep(2)
        except Exception as e:  # noqa: BLE001
            route["status"] = f"client error {e}"
    threading.Thread(target=route_job, daemon=True).start()

    kill_child_at = duration * 0.55
    hh_pre: dict = {}
    while time.time() - t_load < duration:
        el = time.time() - t_load
        if el >= 45 and "worker_killed" not in events:
            pids = (sup.health(5) or {}).get("workers", {}).get("pids") or []
            if pids:
                terminate_pid(pids[0])
                events["worker_killed"] = el
                rep(f"  {el:.0f} s: killed raster worker pid {pids[0]}")
        # the deliberate server kill waits for the route job (it runs inside the server's job object and would die with it)
        if el >= kill_child_at and "child_killed" not in events and (route["status"] in ("done", "error")
                                                                      or el >= duration * 0.8):
            hh_pre = (sup.health(5) or {}).get("workers", {})    # the first server's worker statistics
            pid = sup.proc.pid
            terminate_pid(pid) if WIN else sup.proc.kill()
            events["child_killed"] = el
            rep(f"  {el:.0f} s: killed the server process pid {pid} (the supervisor must replace it)")
        if "child_killed" in events and "recovered" not in events and el > events["child_killed"] + 1:
            if sup.proc.poll() is None and raw_ping(port, 3):
                events["recovered"] = el
                rep(f"  {el:.0f} s: server answering again ({el - events['child_killed']:.0f} s after it was killed)")
        time.sleep(0.5)
    stop.set()
    for th in threads:
        th.join(100)

    # ---- results
    kill_t = events.get("child_killed", 1e9)
    rec_t = events.get("recovered", 1e9)
    steady = [s for s in samples if not (kill_t - 2 <= s["t"] <= rec_t + 5)]
    pings = sorted(s["ping_ms"] for s in steady if s["ping_ok"])
    missed = [s for s in steady if not s["ping_ok"]]
    p95 = pings[int(len(pings) * 0.95) - 1] if pings else None
    rep("")
    rep(f"requests: {len(results)} ({sum(1 for r in results if r[1] == 'abandoned')} abandoned on purpose)")
    by = {}
    for r in results:
        by.setdefault((r[1], r[2]), []).append(r[3])
    for (kind, st), ts in sorted(by.items(), key=lambda kv: str(kv[0])):
        ts.sort()
        rep(f"  {kind:9s} status {st:4d}: {len(ts):5d}  median {ts[len(ts) // 2]:.2f} s  max {ts[-1]:.1f} s")
    check("the server answered /api/ping throughout (outside the deliberate kill)", not missed and pings,
          f"{len(pings)} pings, 95th percentile {p95:.0f} ms, max {pings[-1]:.0f} ms" if pings else "no pings")
    check("ping latency stayed under 3 s", pings and pings[-1] < 3000, f"max {pings[-1]:.0f} ms" if pings else "")
    errors500 = [r for r in results if r[2] == 500]
    check("no internal server errors (HTTP 500)", not errors500, f"{len(errors500)}")
    if errs:
        reasons: dict = {}
        for path, st, body in errs:
            key = (path.split("?")[0].split("/")[1:3] and "/".join(path.split("?")[0].split("/")[:3]), body[:160])
            reasons[key] = reasons.get(key, 0) + 1
        for (kind, body), n in sorted(reasons.items(), key=lambda kv: -kv[1])[:8]:
            rep(f"    {n:4d} x {kind}: {body}")
    check("raster workers started and served remote reads (GDAL in worker processes)",
          (hh_pre.get("spawned") or 0) >= 1 and (hh_pre.get("calls") or 0) >= 1,
          json.dumps({k: hh_pre.get(k) for k in ("spawned", "calls", "timeouts", "errors", "last_error")}))
    after_w = [r for r in results if r[1] == "tile" and r[2] == 200 and events.get("worker_killed", 1e9) + 5 < r[0] < kill_t]
    check("a raster worker was killed and tiles kept coming", "worker_killed" in events and after_w,
          f"{len(after_w)} tiles served after it" if "worker_killed" in events else "no worker was running to kill")
    check("the supervisor replaced the killed server", "recovered" in events,
          f"{rec_t - kill_t:.0f} s" if "recovered" in events else "not recovered")
    after_r = [r for r in results if r[2] == 200 and r[0] > rec_t]
    check("requests served again after the restart", after_r, f"{len(after_r)} ok")
    peak = max((s["mb"] for s in samples), default=0)
    check("memory of the server and its workers stayed bounded", peak < 2500,
          f"peak {peak:.0f} MB private (all processes); commit free min {min(((s['commit_free'] or 0) for s in samples), default=0)} MB")
    check("route job (own process) finished", route.get("status") == "done",
          f"{route.get('status')} in {route.get('elapsed')} s {route.get('error') or ''}")
    hh = sup.health(5) or {}
    rep(f"  after the load: {hh.get('served')} requests served by this server process, {hh.get('cancelled')} cancelled "
        f"(browser gone), {hh.get('rejected')} rejected, workers {json.dumps({k: hh.get('workers', {}).get(k) for k in ('max', 'live', 'calls', 'timeouts', 'errors', 'spawned', 'cancelled', 'budget', 'last_error')})}")
    if hh.get("late_imports"):
        rep(f"  modules first imported by request threads: {[m for _t, _th, m in hh['late_imports']]}")

    # ---- shutdown: nothing may be left
    pids = sup.job.pids() if sup.job else []
    sup.stopping = True
    sup.kill()
    time.sleep(2)
    left = [p for p in pids if pid_alive(p)]
    check("every server process ended with the job object", not left, f"{len(pids)} processes, left: {left}")
    rep("")
    failed = [n for n, ok_ in checks if not ok_]
    rep(f"RESULT: {'ALL PASS' if not failed else 'FAILED: ' + '; '.join(failed)}")
    server_log(f"selftest: {'all pass' if not failed else 'failed: ' + '; '.join(failed)}")
    return 0 if not failed else 1


# =========================================================================== main

BANNER = r"""
  __  __                _   _
 |  \/  | __ _ _ __ ___| \ | | __ ___   __
 | |\/| |/ _` | '__/ __|  \| |/ _` \ \ / /
 | |  | | (_| | |  \__ \ |\  | (_| |\ V /
 |_|  |_|\__,_|_|  |___/_| \_|\__,_| \_/
"""


def parse_args(argv):
    import argparse
    ap = argparse.ArgumentParser(description="MarsNav launcher")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--health-port", type=int, default=0)
    ap.add_argument("--no-browser", action="store_true", help="do not open a browser")
    ap.add_argument("--dev", action="store_true", help="development: enable /api/shutdown, verbose logs")
    ap.add_argument("--headless", action="store_true", help="no interactive menu (serve until stopped)")
    ap.add_argument("--console", action="store_true", help="the text menu + default browser instead of the app window")
    ap.add_argument("--debug-port", type=int, default=0, help="testing: DevTools protocol port for the app window")
    return ap.parse_args(argv)


def _read_server_json(root: Path) -> dict:
    try:
        return json.loads((root / "data_cache" / "server.json").read_text())
    except (OSError, ValueError):
        return {}


def ensure_console() -> None:
    """MarsNav.exe is a windowed program (no console). The text modes (--console, --headless, --selftest, --rebuild)
    attach to the console they were started from, or open one of their own."""
    if not WIN or (sys.stdout is not None and sys.stdin is not None):
        return
    k32 = ctypes.windll.kernel32
    if not k32.AttachConsole(-1):                      # ATTACH_PARENT_PROCESS (started from cmd / a .bat file)
        k32.AllocConsole()
        with contextlib.suppress(Exception):
            k32.SetConsoleTitleW(APP_NAME)
    with contextlib.suppress(OSError):
        sys.stdout = open("CONOUT$", "w", encoding="utf-8", errors="replace", buffering=1)
        sys.stderr = sys.stdout
        sys.stdin = open("CONIN$", "r", encoding="utf-8", errors="replace")


def single_instance_name(root: Path, dev: bool = False) -> str:
    return "Local\\MartianMap_" + hashlib.sha1(str(root.resolve()).lower().encode()).hexdigest()[:16] + ("_dev" if dev else "")


def end_stale_processes() -> None:
    """We are the only supervisor of this folder: any other MarsNav.exe from it (a crash, an old version) is an orphan."""
    if not (is_frozen() and WIN):
        return
    me = os.getpid()
    table = process_table()
    mine, p = set(), me
    while p in table and p not in mine:
        mine.add(p)
        p = table[p][0]
    exe = os.path.normcase(os.path.abspath(sys.executable))
    stale = [pid for pid, (_pp, name) in table.items() if pid not in mine and name.lower() == Path(exe).name.lower()
             and os.path.normcase(image_path(pid) or "") == exe]
    for pid in stale:
        terminate_pid(pid)
    if stale:
        server_log(f"supervisor: ended {len(stale)} leftover MarsNav.exe processes from an earlier run: {stale}")
        time.sleep(1.0)


def run_rebuild(argv: list) -> int:
    """MarsNav.exe --rebuild [--full]: the data pipeline in a console window of its own (Data menu)."""
    ensure_console()
    root = project_root()
    (root / "data_cache").mkdir(exist_ok=True)
    _LOG["path"] = root / "data_cache" / "server.log"
    print(BANNER)
    run_pipeline(root, include_optional="--full" in argv)
    print("\nReload the page in MarsNav (F5) to see the refreshed data.")
    with contextlib.suppress(Exception):
        input("Press Enter to close this window...")
    return 0


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] == "--run-job":
        sys.exit(run_job(sys.argv[2]))
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        sys.exit(run_worker(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == "--serve-child":
        serve_child(parse_args(sys.argv[2:]))
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        ensure_console()
        sys.exit(selftest(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == "--rebuild":
        sys.exit(run_rebuild(sys.argv[2:]))
    args = parse_args(sys.argv[1:])
    if not (args.console or args.headless):
        import desktop                                 # the app window (launcher/desktop.py)
        desktop.run(sys.modules[__name__], args)
        return
    ensure_console()
    root = project_root()
    app_dir = find_app_dir(root)

    print(BANNER)
    print(f"  {APP_NAME} -- EVA traverse planning and guidance for Mars")
    print("  " + "-" * 58)

    if app_dir is None:
        print("\nERROR: could not find the app\\ folder (with index.html).")
        print(f"Looked next to: {root}")
        print("Keep MarsNav.exe in its folder, next to 'app'.")
        input("\nPress Enter to exit...")
        return
    (root / "data_cache").mkdir(exist_ok=True)
    _LOG["path"] = root / "data_cache" / "server.log"

    # one supervisor per project folder (double-clicked twice? bring up the running one instead)
    mutex = single_instance_name(root, args.dev)
    if not single_instance(mutex):
        info = {}
        for _ in range(60):
            info = _read_server_json(root)
            if info.get("url") and raw_ping(int(info.get("port", 0)), 1.0):
                break
            time.sleep(1)
        url = info.get("url") or f"http://127.0.0.1:{args.port}/"
        print(f"\n  MarsNav is already running (its window is open) at {url} -- opening it.")
        if not args.no_browser:
            webbrowser.open(url)
        time.sleep(2.5)
        return
    end_stale_processes()

    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}/"
    sup = Supervisor(root, port, args.dev)
    mem = sys_memory()
    sys_free, proj_free = disk_free_gb(system_drive()), disk_free_gb(root)
    left = leftover_unpack_dirs()
    server_log(f"supervisor pid {os.getpid()} starting ({'exe' if is_frozen() else 'source'}); memory {mem}; "
               f"disk free: system drive {sys_free} GB, project {proj_free} GB; leftover unpack folders {len(left)} "
               f"({sum(b for _d, b in left) / 2**20:.0f} MB)")
    if sys_free is not None and sys_free < 2:
        print(f"\n  WARNING: the system drive has only {sys_free} GB free. Windows then cannot grow its page file,")
        print("  and every program (the browser, this server) can run out of memory. Free some space on it.")
    if left:
        print(f"\n  {len(left)} leftover temporary folders from older builds of MarsNav.exe take "
              f"{sum(b for _d, b in left) / 2**30:.1f} GB on the system drive: choose [C] to remove them.")
    if mem.get("commit_free_mb", 9999) < 1200:
        print(f"\n  Note: Windows has only {mem.get('commit_free_mb')} MB of memory commit left (RAM + page file).")
        print("  Close other large programs if the map is slow; the server adapts by using fewer raster workers.")
    print("\n  Starting the local server (the first start after an update can take a minute)...")
    if not sup.start():
        print("  The server did not start. See data_cache\\server.log and data_cache\\server_child.log.")
        sup.kill()
        if not args.headless:
            input("\nPress Enter to exit...")
        return
    threading.Thread(target=sup.monitor, daemon=True, name="supervisor").start()
    server_log(f"supervisor: server child running on port {port} (supervisor pid {os.getpid()})")

    print(f"\n  Serving : {app_dir}")
    print(f"  Address : {url}")
    with contextlib.suppress(OSError):
        (root / "data_cache" / "server.json").write_text(json.dumps({"port": port, "url": url, "pid": os.getpid(),
                                                                     "health_port": sup.health_port, "dev": args.dev}))
    time.sleep(0.3)
    if not args.no_browser:
        try:
            webbrowser.open(url)
            print("  Opened in your default browser.")
        except Exception:  # noqa: BLE001
            print("  Could not auto-open a browser -- open the address above by hand.")
    if args.headless:
        print("  Headless: serving until this window is closed.")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        sup.stopping = True
        sup.kill()
        return

    print("\n  This window runs MarsNav. Leave it open while you use the app")
    print("  (it restarts the local server by itself if it ever stops answering). Options:")
    print("    [O] Open / re-open the app in your browser")
    print("    [E] Open the jezero_east (20 m-only) demo site")
    print("    [R] Rebuild Mars data from raw NASA/USGS sources (advanced, ~10 min, needs internet)")
    print("    [F] Full rebuild: also the optional Jezero 1 m DTMs N, E and DL (+350 MB)")
    print("    [S] Server status (health, memory, raster workers)")
    print("    [C] Clean up temporary folders left by older builds (frees space on the system drive)")
    print("    [Q] Quit and stop the server\n")

    while True:
        try:
            choice = input("> ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if choice in ("q", "quit", "exit"):
            break
        elif choice in ("o", "open", ""):
            webbrowser.open(url)
        elif choice == "e":
            webbrowser.open(url + "#jezero_east")
        elif choice == "r":
            run_pipeline(root)
        elif choice == "f":
            run_pipeline(root, include_optional=True)
        elif choice == "s":
            h = sup.health(5) or {}
            c = sup.job_census()
            print(f"  server pid {h.get('pid')}  up {h.get('uptime_s')} s  served {h.get('served')}  busy {h.get('busy')}/"
                  f"{h.get('threads')}  queued {h.get('queued')}  restarts (10 min) {len(sup.restarts)}")
            print(f"  memory: {c['total_mb']} MB in {len(c['pids'])} processes; commit free "
                  f"{c['memory'].get('commit_free_mb')} of {c['memory'].get('commit_limit_mb')} MB")
            w = h.get("workers") or {}
            print(f"  raster workers: {w.get('live')}/{w.get('max')} live, {w.get('calls')} reads, "
                  f"{w.get('timeouts')} timed out, {w.get('errors')} failed")
            print(f"  disk free: system drive {disk_free_gb(system_drive())} GB, project drive {disk_free_gb(root)} GB")
        elif choice == "c":
            items = leftover_unpack_dirs()
            if not items:
                print("  Nothing to clean up.")
            else:
                print(f"  Removing {len(items)} folders ({sum(b for _d, b in items) / 2**30:.2f} GB) from the temp folder...")
                freed = clean_leftovers(items)
                print(f"  Freed {freed / 2**30:.2f} GB.")
                server_log(f"clean-up: removed leftover unpack folders, freed {freed / 2**20:.0f} MB")
        else:
            print("  Type O, E, R, F, S, C or Q.")

    print("\n  Shutting down the server...")
    sup.stopping = True
    sup.kill()
    print("  Done. You can close this window.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("\nMarsNav hit an unexpected error:\n")
        traceback.print_exc()
        if not any(a in sys.argv for a in ("--serve-child", "--worker", "--run-job", "--selftest")):
            if sys.stdin is not None:
                with contextlib.suppress(Exception):
                    input("\nPress Enter to exit...")
            elif WIN:
                with contextlib.suppress(Exception):
                    ctypes.windll.user32.MessageBoxW(None, "MarsNav hit an unexpected error:\n\n" +
                                                     traceback.format_exc()[-1800:], APP_NAME, 0x10)
        sys.exit(1)
