"""Root-cause trace for "the local server goes offline" (Windows). Reproduces each suspected failure in isolation, in fresh
processes, and writes what happened to data_cache/trace_root_cause.txt.

  python tools/trace_root_cause.py            (or double-click trace_root_cause.bat in the project folder)

Experiments
  census        memory / commit of the machine and every MarsNav.exe process (with its command line), before and after
                stopping the old instance
  E1..E4        importing numpy in a thread while another thread reads the process's stdin pipe (what the v12 server child
                did to notice its parent going away) -- numpy issue #24290
  E5            private (committed) memory of one process after importing numpy + scipy + rasterio, with OpenBLAS at its
                default thread count and with OPENBLAS_NUM_THREADS=1 (numpy issue #13432)
  E6            time and memory of remote COG reads with the old GDAL settings and with the new ones
"""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data_cache" / "trace_root_cause.txt"
HERE = Path(__file__).resolve()


def _log(msg=""):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(line + "\n")


# ------------------------------------------------------------------ Windows memory helpers (standard library only)

if os.name == "nt":
    import ctypes.wintypes as wt
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)

    class MEMSTAT(ctypes.Structure):
        _fields_ = [("dwLength", wt.DWORD), ("dwMemoryLoad", wt.DWORD), ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    class PMC(ctypes.Structure):
        _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t)]

    k32.GetCurrentProcess.restype = wt.HANDLE
    k32.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(MEMSTAT)]
    psapi.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.POINTER(PMC), wt.DWORD]
    psapi.GetProcessMemoryInfo.restype = wt.BOOL


def sysmem() -> str:
    ms = MEMSTAT()
    ms.dwLength = ctypes.sizeof(ms)
    k32.GlobalMemoryStatusEx(ctypes.byref(ms))
    G = 1024 ** 3
    return (f"RAM {ms.ullTotalPhys / G:.1f} GB (free {ms.ullAvailPhys / G:.1f} GB, load {ms.dwMemoryLoad}%), "
            f"commit limit {ms.ullTotalPageFile / G:.1f} GB (free {ms.ullAvailPageFile / G:.1f} GB)")


def own_commit_mb() -> float:
    pmc = PMC()
    pmc.cb = ctypes.sizeof(pmc)
    psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
    return pmc.PagefileUsage / 2 ** 20


def census(title: str) -> list:
    _log(f"--- census: {title}")
    _log("  " + sysmem())
    ps = ("Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('MarsNav.exe','python.exe','pythonw.exe') } | "
          "Select-Object ProcessId,ParentProcessId,Name,ThreadCount,WorkingSetSize,PrivatePageCount,CreationDate,CommandLine | "
          "ConvertTo-Json -Depth 2")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True,
                           timeout=60, stdin=subprocess.DEVNULL, creationflags=0x08000000)
        rows = json.loads(r.stdout or "[]")
        rows = [rows] if isinstance(rows, dict) else rows
    except Exception as e:  # noqa: BLE001
        _log(f"  process list failed: {e}")
        return []
    tot = 0.0
    mine = os.getpid()
    for p in sorted(rows, key=lambda p: p.get("ProcessId", 0)):
        if p.get("ProcessId") == mine:
            continue
        priv = (p.get("PrivatePageCount") or 0) / 2 ** 20
        if p.get("Name") == "MarsNav.exe":
            tot += priv
        cmd = (p.get("CommandLine") or "")
        cmd = cmd if len(cmd) < 150 else cmd[:150] + "..."
        _log(f"  {p.get('Name'):15s} pid {p.get('ProcessId'):6d} parent {p.get('ParentProcessId'):6d} threads {p.get('ThreadCount'):4d} "
             f"private {priv:7.0f} MB  ws {(p.get('WorkingSetSize') or 0) / 2**20:7.0f} MB  | {cmd}")
    _log(f"  MarsNav.exe processes: {sum(1 for p in rows if p.get('Name') == 'MarsNav.exe')}, private memory {tot:.0f} MB")
    return rows


# ------------------------------------------------------------------ child experiments

def child(exp: str) -> None:
    import faulthandler
    faulthandler.enable()
    t0 = time.time()
    if exp in ("E1", "E4"):          # the v12 server child: a thread blocked reading stdin, then numpy imported in another thread
        threading.Thread(target=lambda: sys.stdin.buffer.read(1), daemon=True, name="stdin-reader").start()
        time.sleep(0.5)
        done = threading.Event()
        threading.Thread(target=lambda: (__import__("numpy"), done.set()), daemon=True, name="importer").start()
        if done.wait(30):
            print(f"RESULT ok: numpy imported in {time.time() - t0 - 0.5:.1f} s", flush=True)
        else:
            print("RESULT HUNG: numpy import did not finish in 30 s; thread stacks:", flush=True)
            faulthandler.dump_traceback(all_threads=True)
            sys.stdout.flush()
        os._exit(0)
    if exp == "E2":                  # same, without the stdin reader (stdin = NUL)
        done = threading.Event()
        threading.Thread(target=lambda: (__import__("numpy"), done.set()), daemon=True).start()
        print(("RESULT ok: numpy imported in %.1f s" % (time.time() - t0)) if done.wait(30) else "RESULT HUNG", flush=True)
        os._exit(0)
    if exp == "E3":                  # stdin reader, but numpy imported on the main thread first
        import numpy  # noqa: F401
        t1 = time.time() - t0
        threading.Thread(target=lambda: sys.stdin.buffer.read(1), daemon=True).start()
        time.sleep(0.5)
        done = threading.Event()
        threading.Thread(target=lambda: (__import__("scipy.ndimage"), done.set()), daemon=True).start()
        print((f"RESULT ok: numpy on main thread {t1:.1f} s, then scipy.ndimage in a thread with the reader running")
              if done.wait(30) else "RESULT HUNG (scipy in thread)", flush=True)
        os._exit(0)
    if exp == "E5":
        c0 = own_commit_mb()
        import numpy  # noqa: F401
        c1 = own_commit_mb()
        import scipy.ndimage  # noqa: F401
        import scipy.sparse.csgraph  # noqa: F401
        c2 = own_commit_mb()
        import rasterio  # noqa: F401
        c3 = own_commit_mb()
        numpy.dot(numpy.ones((300, 300)), numpy.ones((300, 300)))     # a BLAS call: starts OpenBLAS's threads/buffers
        c4 = own_commit_mb()
        print(f"RESULT private MB: start {c0:.0f}, +numpy {c1:.0f}, +scipy {c2:.0f}, +rasterio {c3:.0f}, after a BLAS call {c4:.0f}; "
              f"threads {threading.active_count()} python / OPENBLAS_NUM_THREADS={os.environ.get('OPENBLAS_NUM_THREADS', '(default)')} "
              f"cpus {os.cpu_count()} gdal {rasterio.__gdal_version__}", flush=True)
        os._exit(0)
    if exp.startswith("E6"):
        sys.path.insert(0, str(ROOT))
        os.environ["MM_ROOT"] = str(ROOT)
        from planet import config
        config.configure(ROOT)
        import rasterio
        from rasterio.windows import from_bounds
        old = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "GDAL_HTTP_MULTIRANGE": "YES", "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
               "GDAL_HTTP_TIMEOUT": "20", "GDAL_HTTP_CONNECTTIMEOUT": "20", "GDAL_HTTP_MAX_RETRY": "2", "GDAL_HTTP_RETRY_DELAY": "1",
               "VSI_CACHE": "TRUE", "VSI_CACHE_SIZE": str(256 * 2**20), "GDAL_CACHEMAX": 512, "CPL_VSIL_CURL_CACHE_SIZE": str(256 * 2**20)}
        new = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "GDAL_HTTP_MULTIRANGE": "YES", "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
               "GDAL_HTTP_TIMEOUT": "10", "GDAL_HTTP_CONNECTTIMEOUT": "5", "GDAL_HTTP_LOW_SPEED_TIME": "5",
               "GDAL_HTTP_LOW_SPEED_LIMIT": "10240", "GDAL_HTTP_MAX_RETRY": "1", "GDAL_HTTP_RETRY_DELAY": "1",
               "VSI_CACHE": "FALSE", "GDAL_CACHEMAX": 128, "CPL_VSIL_CURL_CACHE_SIZE": str(64 * 2**20)}
        env = old if exp == "E6old" else new
        try:
            import certifi
            env["CURL_CA_BUNDLE"] = certifi.where()
        except Exception:  # noqa: BLE001
            pass
        cat = json.loads((config.PATHS["catalog"] / "stac_ctx.json").read_text())["items"]
        near = [it for it in cat if it["bbox"][0] < 77.5 < it["bbox"][2] and it["bbox"][1] < 18.4 < it["bbox"][3]][:2] or cat[:2]
        c0 = own_commit_mb()
        times = []
        for it in near:
            bw, bs, be, bn = it["bbox"]
            cx, cy = (bw + be) / 2, (bs + bn) / 2
            for k in range(3):
                w = cx - 0.015 + 0.01 * k
                t = time.time()
                try:
                    with rasterio.Env(**env):
                        url = "/vsicurl/" + it["dtm"]
                        with rasterio.open(url) as src:
                            from rasterio.warp import transform_bounds
                            from rasterio.windows import Window
                            b = transform_bounds("+proj=longlat +R=3396190 +no_defs", src.crs, w, cy, w + 0.01, cy + 0.01) \
                                if src.crs and not src.crs.is_geographic else (w, cy, w + 0.01, cy + 0.01)
                            win = from_bounds(*b, transform=src.transform).intersection(Window(0, 0, src.width, src.height))
                            src.read(1, window=win, out_shape=(257, 257))
                    times.append(f"{time.time() - t:.1f}s")
                except Exception as e:  # noqa: BLE001
                    times.append(f"ERR {type(e).__name__} after {time.time() - t:.1f}s")
        print(f"RESULT {exp}: {len(near)} CTX DTMs x 3 windows: {', '.join(times)}; private MB {c0:.0f} -> {own_commit_mb():.0f}", flush=True)
        os._exit(0)


def run_child(exp: str, env_extra: dict | None = None, stdin_pipe: bool = False, limit: float = 45) -> str:
    env = {**os.environ, **(env_extra or {})}
    for k in list(env):
        if k.startswith("OPENBLAS") and not (env_extra and k in env_extra):
            env.pop(k)
    outp = ROOT / "data_cache" / f"trace_{exp}.out"
    with open(outp, "w", encoding="utf-8") as fo:
        p = subprocess.Popen([sys.executable, "-X", "faulthandler", str(HERE), "--child", exp],
                             stdin=subprocess.PIPE if stdin_pipe else subprocess.DEVNULL, stdout=fo, stderr=fo, env=env,
                             cwd=str(ROOT), creationflags=0x08000000)
        t0 = time.time()
        while p.poll() is None and time.time() - t0 < limit:
            time.sleep(0.2)
        killed = p.poll() is None
        if killed:
            p.kill()
            p.wait(10)
        if p.stdin:
            p.stdin.close()
    txt = outp.read_text(encoding="utf-8", errors="replace")
    res = [ln for ln in txt.splitlines() if ln.startswith("RESULT")]
    head = res[0] if res else ("NO RESULT (process killed after %.0f s: fully stuck)" % limit if killed else "NO RESULT")
    stacks = ""
    if "HUNG" in head or not res:
        stacks = "\n".join("      " + ln for ln in txt.splitlines()[-30:])
    return head + (("\n" + stacks) if stacks else "")


def temp_census() -> None:
    """Disk space where PyInstaller one-file programs unpack themselves, and their _MEI folders."""
    import shutil
    import tempfile
    tmp = Path(tempfile.gettempdir())
    du = shutil.disk_usage(tmp)
    _log(f"--- temp folder {tmp}: disk free {du.free / 2**30:.1f} GB of {du.total / 2**30:.1f} GB")
    rows = []
    for d in tmp.glob("_MEI*"):
        if not d.is_dir():
            continue
        size = 0
        for root, _dirs, files in os.walk(d):
            for f in files:
                try:
                    size += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        ours = all((d / n).exists() for n in ("rasterio.libs", "scipy.libs", "certifi"))
        rows.append((d.stat().st_mtime, d.name, size, ours))
    for mt, name, size, ours in sorted(rows):
        _log(f"  {name}  {time.strftime('%Y-%m-%d %H:%M', time.localtime(mt))}  {size / 2**20:7.0f} MB  {'MarsNav' if ours else ''}")
    _log(f"  {len(rows)} unpack folders, {sum(r[2] for r in rows) / 2**30:.2f} GB "
         f"({sum(1 for r in rows if r[3])} from MarsNav)")


def main():
    OUT.parent.mkdir(exist_ok=True)
    only = [a for a in sys.argv[1:] if a.startswith("E") or a == "temp"]
    if only == ["temp"]:
        _log("")
        census("now")
        temp_census()
        return
    if only:
        _log(f"--- rerun of {' '.join(only)}")
        one = {"OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "GOTO_NUM_THREADS": "1"}
        if "E5" in only:
            _log("E5  committed (private) memory of one process after the scientific imports")
            _log("    default OpenBLAS threads -> " + run_child("E5", limit=90))
            _log("    OPENBLAS_NUM_THREADS=1   -> " + run_child("E5", one, limit=90))
        if "E6" in only:
            _log("E6  remote CTX DTM window reads (network)")
            _log("    old GDAL settings -> " + run_child("E6old", one, limit=240))
            _log("    new GDAL settings -> " + run_child("E6new", one, limit=240))
        _log("rerun finished")
        return
    OUT.write_text("", encoding="utf-8")
    _log(f"MarsNav root-cause trace. Python {sys.version.split()[0]} ({sys.executable}), {os.cpu_count()} logical CPUs")
    rows = census("before")
    if any(p.get("Name") == "MarsNav.exe" for p in rows):
        _log("stopping every MarsNav.exe (the old, restart-looping instance) so the experiments run on a quiet machine")
        subprocess.run(["taskkill", "/F", "/T", "/IM", "MarsNav.exe"], capture_output=True, stdin=subprocess.DEVNULL,
                       creationflags=0x08000000)
        time.sleep(3)
        census("after stopping MarsNav.exe")
    _log("")
    _log("E1  v12 server child pattern: stdin is a pipe, one thread blocked reading it, numpy imported in another thread")
    _log("    -> " + run_child("E1", stdin_pipe=True))
    _log("E2  same, stdin = NUL and no reader thread")
    _log("    -> " + run_child("E2"))
    _log("E3  stdin pipe + reader thread, but numpy imported on the main thread before the reader starts")
    _log("    -> " + run_child("E3", stdin_pipe=True))
    _log("E4  E1 with OPENBLAS_NUM_THREADS=1")
    _log("    -> " + run_child("E4", {"OPENBLAS_NUM_THREADS": "1"}, stdin_pipe=True))
    _log("")
    _log("E5  committed (private) memory of one process after the scientific imports")
    _log("    default OpenBLAS threads -> " + run_child("E5", limit=90))
    one = {"OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "GOTO_NUM_THREADS": "1"}
    _log("    OPENBLAS_NUM_THREADS=1   -> " + run_child("E5", one, limit=90))
    _log("")
    _log("E6  remote CTX DTM window reads (network)")
    _log("    old GDAL settings -> " + run_child("E6old", one, limit=240))
    _log("    new GDAL settings -> " + run_child("E6new", one, limit=240))
    _log("")
    census("end")
    _log("trace finished")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--child":
        child(sys.argv[2])
    else:
        main()
