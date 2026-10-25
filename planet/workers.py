"""Raster worker processes: every GDAL read of a remote NASA / USGS cloud-optimised GeoTIFF runs in one of these, never in
the web server. A read that hangs on the network, or GDAL misbehaving, can then only stall a worker, which is killed and
replaced; the server keeps answering.

Design (rebuilt from the ground up after tracing the server outages on Windows):
  * Workers talk to the server over a private localhost TCP socket (a random token authenticates them). Nothing uses the
    processes' standard handles as pipes: a thread blocked reading a stdin pipe makes every later DLL load in that process
    hang forever on Windows (numpy issue #24290, reproduced on the target laptop by tools/trace_root_cause.py).
  * Each worker is single-threaded, imports everything it needs on its main thread before it takes work, and uses bounded
    GDAL caches (planet/net.py); it is recycled after RECYCLE_AFTER reads so memory cannot creep.
  * The pool size follows the free commit memory of the machine (MM_WORKERS_MAX, set by the launcher).
  * The server side waits for a free worker in short steps, so a request whose browser has gone away (map panned) stops
    waiting at once (Cancelled), and a tile has a time budget after which no new remote read is started (the tile is then
    served provisional, not cached, and rebuilt later).
Workers run as `MarsNav.exe --worker --connect PORT --token T` (or launcher/martian_map.py when not frozen)."""
from __future__ import annotations

import contextlib
import importlib
import itertools
import json
import os
import pickle
import queue
import secrets
import socket
import struct
import subprocess
import sys
import threading
import time

CALL_TIMEOUT = 40.0          # s: one remote read (GDAL itself gives up on a stalled request after ~10-20 s, see net.py)
RECYCLE_AFTER = 300          # reads per worker before it is replaced by a fresh process
SPAWN_TIMEOUT = 120.0        # s: a new worker imports numpy + rasterio (slow the first time antivirus scans the files)
ALLOWED_PREFIX = "planet.cog:"
CREATE_NO_WINDOW = 0x08000000


class ReadTimeout(Exception):
    """A remote read did not finish in time, or the tile's time budget is used up."""


class Cancelled(BaseException):
    """The browser that asked for this has gone away (BaseException: it unwinds through `except Exception` handlers)."""


# ------------------------------------------------------------------ framing (4-byte length + payload)

def send_msg(sock: socket.socket, data: bytes) -> None:
    sock.sendall(struct.pack(">I", len(data)) + data)


def _recv_exact(sock: socket.socket, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(min(n - len(buf), 1 << 20))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def recv_msg(sock: socket.socket) -> bytes | None:
    head = _recv_exact(sock, 4)
    if head is None:
        return None
    return _recv_exact(sock, struct.unpack(">I", head)[0])


# ------------------------------------------------------------------ per-request context (time budget, cancellation)

_ctx = threading.local()


@contextlib.contextmanager
def request(budget: float | None = None, cancel=None):
    """Within this block, remote reads by this thread stop being started after `budget` seconds, and waiting for a worker
    stops (Cancelled) as soon as cancel() returns True."""
    old = (getattr(_ctx, "deadline", None), getattr(_ctx, "cancel", None))
    _ctx.deadline = time.time() + budget if budget else None
    _ctx.cancel = cancel
    try:
        yield
    finally:
        _ctx.deadline, _ctx.cancel = old


def cancelled() -> bool:
    c = getattr(_ctx, "cancel", None)
    try:
        return bool(c and c())
    except Exception:  # noqa: BLE001
        return True


def time_left() -> float | None:
    d = getattr(_ctx, "deadline", None)
    return None if d is None else d - time.time()


# ------------------------------------------------------------------ server side: the pool

def enabled() -> bool:
    return os.environ.get("MM_WORKERS") == "1" and os.environ.get("MM_IN_WORKER") != "1"


def _cmd(port: int, token: str, nonce: int) -> list:
    from .config import PATHS
    extra = ["--worker", "--connect", str(port), "--token", token, "--nonce", str(nonce)]
    if getattr(sys, "frozen", False):
        return [sys.executable, *extra]
    return [sys.executable, "-u", str(PATHS["root"] / "launcher" / "martian_map.py"), *extra]


class _Worker:
    def __init__(self, proc: subprocess.Popen, sock: socket.socket, pid: int):
        self.proc, self.sock = proc, sock
        self.pid = pid                 # the Python process doing the work (a venv's python.exe is a launcher in front of it)
        self.calls = 0
        self.started = time.time()

    def alive(self) -> bool:
        return self.proc.poll() is None

    def close(self, kill: bool = True) -> None:
        with contextlib.suppress(OSError):
            self.sock.close()          # a healthy worker exits by itself when its socket closes
        if kill:
            with contextlib.suppress(OSError):
                self.proc.kill()
            if self.pid != self.proc.pid:
                with contextlib.suppress(OSError):
                    os.kill(self.pid, 9)          # Windows: TerminateProcess
        # reap it in the background (never leave a zombie handle behind)
        threading.Thread(target=_reap, args=(self.proc,), daemon=True, name=f"reap-{self.pid}").start()


def _reap(p: subprocess.Popen) -> None:
    try:
        p.wait(20)
    except Exception:  # noqa: BLE001
        with contextlib.suppress(Exception):
            p.kill()
            p.wait(10)


class Pool:
    def __init__(self, max_size: int):
        self.max_size = max(1, max_size)
        self.token = secrets.token_hex(16)
        self.lsock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.lsock.bind(("127.0.0.1", 0))
        self.lsock.listen(16)
        self.port = self.lsock.getsockname()[1]
        self.idle: queue.LifoQueue = queue.LifoQueue()
        self.live: dict[int, _Worker] = {}
        self.lock = threading.Lock()
        self.spawn_lock = threading.Lock()
        self.starting = 0
        self.spawn_blocked_until = 0.0     # after a worker failed to start: do not keep trying (and failing) per tile
        self.ids = itertools.count(1)
        self.stats = {"calls": 0, "timeouts": 0, "errors": 0, "spawned": 0, "recycled": 0, "cancelled": 0, "budget": 0,
                      "spawn_s": None, "last_error": None}

    # -- workers
    def _spawn(self) -> _Worker:
        from .config import PATHS
        env = {**os.environ, "MM_ROOT": str(PATHS["root"]), "MM_IN_WORKER": "1", "MM_PARENT_PID": str(os.getpid()),
               "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
        t0 = time.time()
        nonce = next(self.ids)
        with self.spawn_lock:
            logf = open(PATHS["root"] / "data_cache" / "workers.log", "ab")
            try:
                proc = subprocess.Popen(_cmd(self.port, self.token, nonce), stdin=subprocess.DEVNULL, stdout=logf, stderr=logf,
                                        env=env, cwd=str(PATHS["root"]), creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0)
            finally:
                logf.close()
            self.lsock.settimeout(1.0)
            while True:
                if proc.poll() is not None:
                    raise RuntimeError(f"raster worker exited while starting (code {proc.returncode}); see data_cache/workers.log")
                if time.time() - t0 > SPAWN_TIMEOUT:
                    with contextlib.suppress(OSError):
                        proc.kill()
                    raise RuntimeError("raster worker did not start in time")
                try:
                    conn, _addr = self.lsock.accept()
                except socket.timeout:
                    continue
                try:
                    conn.settimeout(10)
                    hello = json.loads((recv_msg(conn) or b"{}").decode())
                except (OSError, ValueError):
                    conn.close()
                    continue
                if hello.get("token") != self.token or hello.get("nonce") != nonce:
                    conn.close()          # a stale worker of an earlier spawn, or not ours
                    continue
                conn.settimeout(None)
                w = _Worker(proc, conn, int(hello.get("pid") or proc.pid))
                with self.lock:
                    self.live[w.pid] = w
                self.stats["spawned"] += 1
                self.stats["spawn_s"] = round(time.time() - t0, 1)
                return w

    def _drop(self, w: _Worker, kill: bool = True) -> None:
        with self.lock:
            self.live.pop(w.pid, None)
        w.close(kill=kill)

    def _get(self, wait_until: float) -> _Worker:
        while True:
            try:
                w = self.idle.get_nowait()
                if w.alive():
                    return w
                self._drop(w)
                continue
            except queue.Empty:
                pass
            with self.lock:
                blocked = time.time() < self.spawn_blocked_until
                can = not blocked and len(self.live) + self.starting < self.max_size
                if can:
                    self.starting += 1
                none_at_all = not self.live and not self.starting
            if blocked and none_at_all:
                raise ReadTimeout(f"raster workers unavailable: {self.stats.get('last_error')}")
            if can:
                try:
                    return self._spawn()
                except Exception as e:  # noqa: BLE001
                    self.spawn_blocked_until = time.time() + 30
                    self.stats["last_error"] = f"{time.strftime('%H:%M:%S')} start: {e}"
                    raise ReadTimeout(f"raster worker could not start: {e}") from None
                finally:
                    with self.lock:
                        self.starting -= 1
            try:
                w = self.idle.get(timeout=0.25)
                if w.alive():
                    return w
                self._drop(w)
            except queue.Empty:
                pass
            if cancelled():
                self.stats["cancelled"] += 1
                raise Cancelled()
            if time.time() > wait_until:
                raise ReadTimeout("all raster workers busy")

    def call(self, fn: str, args=(), kwargs=None, timeout: float = CALL_TIMEOUT):
        if not fn.startswith(ALLOWED_PREFIX):
            raise ValueError(f"not a worker function: {fn}")
        left = time_left()
        if left is not None and left < 2.0:
            self.stats["budget"] += 1
            raise ReadTimeout("tile time budget used up")
        if cancelled():
            self.stats["cancelled"] += 1
            raise Cancelled()
        w = self._get(time.time() + (min(left, 30.0) if left is not None else 30.0))
        self.stats["calls"] += 1
        rid = next(self.ids)
        try:
            w.sock.settimeout(timeout)
            send_msg(w.sock, json.dumps({"id": rid, "fn": fn, "args": list(args), "kwargs": kwargs or {}}).encode())
            raw = recv_msg(w.sock)
            if raw is None:
                raise RuntimeError("raster worker exited")
            rep = pickle.loads(raw)
            if rep.get("id") != rid:
                raise RuntimeError("raster worker protocol error")
        except BaseException as e:  # noqa: BLE001 - hung, dead, or interrupted: never reuse this worker
            self._drop(w)
            self.stats["last_error"] = f"{time.strftime('%H:%M:%S')} {type(e).__name__}: {e}"
            if isinstance(e, socket.timeout):
                self.stats["timeouts"] += 1
                raise ReadTimeout(f"{fn.split(':')[-1]} did not finish in {timeout:.0f} s; worker replaced") from None
            self.stats["errors"] += 1
            if isinstance(e, (OSError, RuntimeError, EOFError, pickle.UnpicklingError)):
                raise ReadTimeout(f"{fn.split(':')[-1]} failed: {type(e).__name__}: {e}") from None
            raise
        w.calls += 1
        if w.calls >= RECYCLE_AFTER:
            self.stats["recycled"] += 1
            self._drop(w, kill=False)       # closes its socket: the worker exits cleanly
        else:
            self.idle.put(w)
        if not rep.get("ok"):
            raise RuntimeError(rep.get("error", "worker error"))
        return rep.get("result")

    def warm(self, n: int = 1) -> None:
        """Start n workers ahead of the first map tile."""
        for _ in range(min(n, self.max_size)):
            with self.lock:
                if len(self.live) + self.starting >= self.max_size:
                    return
                self.starting += 1
            try:
                self.idle.put(self._spawn())
            except Exception as e:  # noqa: BLE001
                self.stats["last_error"] = f"{time.strftime('%H:%M:%S')} warm-up: {e}"
                return
            finally:
                with self.lock:
                    self.starting -= 1

    def status(self) -> dict:
        with self.lock:
            pids = sorted(self.live)
        return {**self.stats, "max": self.max_size, "live": len(pids), "idle": self.idle.qsize(), "pids": pids}


def pool() -> Pool:
    # kept on the sys module so a reload of the planet package does not start a second set of workers
    p = getattr(sys, "_martian_map_workers", None)
    if p is None:
        p = Pool(int(os.environ.get("MM_WORKERS_MAX", "3") or 3))
        sys._martian_map_workers = p
    return p


def call(fn: str, *args, timeout: float = CALL_TIMEOUT, **kwargs):
    return pool().call(fn, args, kwargs, timeout)


def status() -> dict:
    p = getattr(sys, "_martian_map_workers", None)
    return {"enabled": enabled(), **(p.status() if p else {"live": 0})}


# ------------------------------------------------------------------ worker side

def worker_main(port: int, token: str, nonce: int = 0) -> int:
    """Body of a worker process (the launcher has already imported numpy / rasterio on this, the only, thread)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=30)
    s.settimeout(None)
    send_msg(s, json.dumps({"token": token, "nonce": nonce, "pid": os.getpid()}).encode())
    while True:
        try:
            raw = recv_msg(s)
        except OSError:
            return 0
        if raw is None:
            return 0                       # the server closed the connection (recycled, or the server ended)
        rid = None
        try:
            req = json.loads(raw.decode())
            rid = req.get("id")
            fn_path = req["fn"]
            if not fn_path.startswith(ALLOWED_PREFIX):
                raise ValueError(f"not a worker function: {fn_path}")
            mod, name = fn_path.split(":")
            fn = getattr(importlib.import_module(mod), name)
            rep = {"id": rid, "ok": True, "result": fn(*req.get("args", []), **req.get("kwargs", {}))}
        except Exception as exc:  # noqa: BLE001
            rep = {"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        try:
            send_msg(s, pickle.dumps(rep, protocol=pickle.HIGHEST_PROTOCOL))
        except OSError:
            return 0
