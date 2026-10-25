"""Long-running work (routes across the planet, site builds, offline pre-caching) runs in background threads; the app
polls /api/job/<id>. Everything a job prints goes into its log (per thread, so parallel jobs do not mix)."""
from __future__ import annotations

import io
import sys
import threading
import time
import traceback
import uuid

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_local = threading.local()


class _Router(io.TextIOBase):
    """sys.stdout replacement: text written from a job thread goes to that job's log, the rest to the real stream."""

    def __init__(self, real):
        self.real = real

    def write(self, s):
        job = getattr(_local, "job", None)
        if job is not None:
            buf = job.setdefault("_buf", "") + s
            *lines, rest = buf.split("\n")
            job["_buf"] = rest
            for ln in lines:
                if ln.strip():
                    job["log"].append([round(time.time() - job["started"], 1), ln.rstrip()])
                    del job["log"][:-400]
            return len(s)
        try:
            return self.real.write(s)
        except Exception:  # noqa: BLE001
            return len(s)

    def flush(self):
        try:
            self.real.flush()
        except Exception:  # noqa: BLE001
            pass


_installed = False


def _install():
    global _installed
    if not _installed:
        sys.stdout = _Router(sys.stdout)
        _installed = True


def start(kind: str, fn, *args, **kw) -> str:
    _install()
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "kind": kind, "status": "running", "started": time.time(), "log": [], "result": None, "error": None, "progress": None}
    with _lock:
        _jobs[jid] = job
        # keep the last 50 jobs
        for old in sorted(_jobs.values(), key=lambda j: j["started"])[:-50]:
            _jobs.pop(old["id"], None)

    def log(msg):
        job["log"].append([round(time.time() - job["started"], 1), str(msg)])
        del job["log"][:-400]

    def run():
        _local.job = job
        try:
            job["result"] = fn(*args, log=log, **kw)
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = f"{type(e).__name__}: {e}"
            log(traceback.format_exc(limit=6))
        finally:
            job["ended"] = time.time()
            _local.job = None
    threading.Thread(target=run, daemon=True, name=f"job-{kind}-{jid}").start()
    return jid


def get(jid: str, since: int = 0) -> dict | None:
    j = _jobs.get(jid)
    if not j:
        return None
    return {"id": j["id"], "kind": j["kind"], "status": j["status"], "elapsed": round((j.get("ended") or time.time()) - j["started"], 1),
            "log": j["log"][since:], "log_len": len(j["log"]), "result": j["result"] if j["status"] == "done" else None,
            "error": j["error"], "diag": j.get("diag")}


def running() -> list:
    return [{"id": j["id"], "kind": j["kind"], "status": j["status"]} for j in _jobs.values() if j["status"] == "running"]


def start_process(kind: str, fn_path: str, *args, **kw) -> str:
    """Run a long job ("module:function", JSON-able arguments) in its own process: the launcher itself with --run-job
    (MarsNav.exe, or launcher/martian_map.py from source). Routes, site builds, data rebuilds and offline pre-caching
    then cannot slow or freeze the web server, and the memory they use is returned when they finish.
    The job writes its log to a file (data_cache/planet/jobs/<id>.log) which is followed here; its last line
    "@@RESULT {json}" is the result. No pipes on the job's standard handles: on Windows a pipe read/write pending on a
    standard handle while another thread loads a DLL hangs that process (numpy #24290, see tools/trace_root_cause.py)."""
    import json
    import os
    import subprocess
    from .config import PATHS
    if os.environ.get("MM_RUN_JOB") != "1":
        import importlib
        from .cog import GDAL_LOCK
        mod, name = fn_path.split(":")
        fn = getattr(importlib.import_module(mod), name)

        def locked(*a, log=print, **k):
            with GDAL_LOCK:
                return fn(*a, log=log, **k)
        return start(kind, locked, *args, **kw)
    _install()
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "kind": kind, "status": "running", "started": time.time(), "log": [], "result": None, "error": None, "progress": None}
    with _lock:
        _jobs[jid] = job
        for old in sorted(_jobs.values(), key=lambda j: j["started"])[:-50]:
            _jobs.pop(old["id"], None)
    root = PATHS["root"]
    payload = json.dumps({"fn": fn_path, "args": list(args), "kwargs": kw})
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "--run-job", payload]
    else:
        cmd = [sys.executable, "-u", str(root / "launcher" / "martian_map.py"), "--run-job", payload]
    env = {**os.environ, "MM_ROOT": str(root), "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "MM_IN_WORKER": "1",
           "MM_PARENT_PID": str(os.getpid())}
    flags = 0x08000000 if os.name == "nt" else 0          # CREATE_NO_WINDOW: no console pops up
    log_dir = PATHS["jobs"]
    _trim_logs(log_dir)
    log_path = log_dir / f"{jid}.log"

    def log(msg):
        job["log"].append([round(time.time() - job["started"], 1), str(msg)])
        del job["log"][:-400]

    def line_in(line: str):
        # Windows writes CRLF: strip the line end first, then keep the last carriage-return segment (progress bars).
        # (Splitting on "\r" before stripping kept only the empty text after the final "\r": every line was lost.)
        line = line.rstrip("\r\n").split("\r")[-1].rstrip()
        if line.startswith("@@RESULT "):
            try:
                job["result"] = json.loads(line[9:])
            except ValueError:
                job["result"] = {"ok": True}
        elif line.startswith("@@ERROR "):
            job["error"] = line[8:]
        elif line.strip():
            log(line)

    def run():
        diag = job["diag"] = {"log": str(log_path), "polls": 0, "bytes": 0, "size": 0, "err": None, "rc": None}
        try:
            with open(log_path, "wb") as lf:
                p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=lf, stderr=subprocess.STDOUT, env=env,
                                     cwd=str(root), creationflags=flags)
            job["pid"] = p.pid
            pos, buf = 0, b""
            tail = 0
            while True:
                alive = p.poll() is None
                chunk = _read_from(log_path, pos, diag)
                pos += len(chunk)
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for ln in lines:
                    line_in(ln.decode("utf-8", "replace"))
                if not alive and not chunk:
                    tail += 1
                    if tail >= 3:           # the last lines can land just after the process ends: look twice more
                        break
                time.sleep(0.3)
            if buf.strip():
                line_in(buf.decode("utf-8", "replace"))
            rc = diag["rc"] = p.wait()
            job["status"] = "done" if rc == 0 and job["error"] is None else "error"
            if job["status"] == "error" and not job["error"]:
                job["error"] = f"process exited with code {rc}"
        except Exception as e:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = f"{type(e).__name__}: {e}"
        finally:
            job["ended"] = time.time()
    threading.Thread(target=run, daemon=True, name=f"job-{kind}-{jid}").start()
    return jid


def _read_from(path, pos: int, diag: dict) -> bytes:
    """The bytes a job has added to its log file since pos. The file is opened afresh (unbuffered) on every poll rather
    than kept open: a Python file object kept open across polls returned no new data on Windows (Python 3.14)."""
    import os
    try:
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except OSError as e:
        diag["err"] = f"open: {type(e).__name__}: {e}"
        return b""
    try:
        diag["size"] = os.fstat(fd).st_size
        os.lseek(fd, pos, 0)
        parts = []
        while True:
            b = os.read(fd, 1 << 16)
            if not b:
                break
            parts.append(b)
        data = b"".join(parts)
        diag["polls"] += 1
        diag["bytes"] += len(data)
        return data
    except OSError as e:
        diag["err"] = f"read: {type(e).__name__}: {e}"
        return b""
    finally:
        os.close(fd)


def _trim_logs(log_dir, keep: int = 60) -> None:
    try:
        logs = sorted(log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime)
        for p in logs[:-keep]:
            p.unlink()
    except OSError:
        pass
