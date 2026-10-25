"""Rolling disk cache for streamed tiles (like a flight simulator's rolling cache): every tile built is kept on disk and
served from there next time, including offline; when the cache grows past its limit the least recently used tiles go.
Concurrent requests for the same tile wait for one build instead of building it twice."""
from __future__ import annotations

import os
import threading
import time
from concurrent.futures import Future
from pathlib import Path

from .config import PATHS, cache_limit_bytes

_inflight: dict[str, Future] = {}
_lock = threading.Lock()
_last_trim = [0.0]


def path(kind: str, z: int, y: int, x: int, ext: str, offline: bool = False) -> Path:
    base = PATHS.get("tiles_offline", PATHS["cache"] / "tiles_offline") if offline else PATHS["tiles"]
    return base / kind / str(z) / str(y) / f"{x}.{ext}"


def lookup(kind: str, z: int, y: int, x: int, ext: str):
    """(path, offline_build) of the tile to serve or build: a pre-rendered Local mode tile first, then the rolling cache;
    in Mars mode a tile not cached yet is built into the separate offline cache (from local data only)."""
    from . import localmode, net
    lp = localmode.tile_path(kind, z, y, x, ext)
    if lp.exists():
        return lp, False
    key = path(kind, z, y, x, ext)
    if key.exists() or not net.blocked():
        return key, False
    return path(kind, z, y, x, ext, offline=True), True


def get_or_build(key: Path, build) -> bytes:
    """Return the cached bytes at key, or build(), store and return them (one build per key at a time)."""
    if key.exists():
        try:
            os.utime(key, None)          # touch: most recently used
            return key.read_bytes()
        except OSError:
            if build is None:            # trimmed away a moment ago
                raise
    if build is None:
        return key.read_bytes()
    skey = str(key)
    while True:
        with _lock:
            fut = _inflight.get(skey)
            owner = fut is None
            if owner:
                fut = Future()
                _inflight[skey] = fut
        if owner:
            break
        # another request is building this tile: wait for it in short steps (a browser that went away stops waiting)
        from . import workers
        t_end = time.time() + 120
        while True:
            try:
                return fut.result(timeout=0.5)
            except TimeoutError:
                if workers.cancelled():
                    raise workers.Cancelled() from None
                if time.time() > t_end:
                    raise workers.ReadTimeout("waited too long for the same tile being built by another request") from None
            except workers.Cancelled:
                break                    # that request's browser went away: build it ourselves (loop round)
    try:
        data = build()
        if data is not None:
            key.parent.mkdir(parents=True, exist_ok=True)
            tmp = key.with_suffix(key.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
            tmp.write_bytes(data)
            os.replace(tmp, key)
        fut.set_result(data)
        return data
    except BaseException as e:
        fut.set_exception(e)
        raise
    finally:
        with _lock:
            _inflight.pop(skey, None)
        maybe_trim()


def stats() -> dict:
    n = size = 0
    for root, _dirs, files in os.walk(PATHS["tiles"]):
        for f in files:
            if f.endswith(".tmp"):
                continue
            n += 1
            try:
                size += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return {"tiles": n, "bytes": size, "limit": cache_limit_bytes(), "path": str(PATHS["tiles"])}


def maybe_trim(force: bool = False) -> None:
    if not force and time.time() - _last_trim[0] < 600:
        return
    _last_trim[0] = time.time()
    threading.Thread(target=_trim, daemon=True).start()


def _trim() -> None:
    limit = cache_limit_bytes()
    files = []
    total = 0
    for root, _dirs, fs in os.walk(PATHS["tiles"]):
        for f in fs:
            p = os.path.join(root, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            files.append((st.st_atime if st.st_atime > st.st_mtime else st.st_mtime, st.st_size, p))
            total += st.st_size
    if total <= limit:
        return
    files.sort()
    for _t, sz, p in files:
        if total <= limit * 0.9:
            break
        try:
            os.remove(p)
            total -= sz
        except OSError:
            pass
