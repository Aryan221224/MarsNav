"""HTTP for the planet engine: plain downloads (urllib, certifi CA bundle) and the GDAL settings for reading cloud-optimised
GeoTIFFs straight from NASA/USGS servers with HTTP range requests (only the bytes of the window we need)."""
from __future__ import annotations

import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import certifi
    CA_FILE = certifi.where()
except Exception:  # noqa: BLE001
    CA_FILE = None

UA = "MarsNav/2.0 (NASA Space Apps Challenge 2026 Mars landing-site and EVA planner; local desktop app)"
_ctx = ssl.create_default_context(cafile=CA_FILE) if CA_FILE else ssl.create_default_context()
_state = {"online": None, "checked": 0.0, "last_error": None}
_lock = threading.Lock()

# GDAL /vsicurl/ configuration (applied through rasterio.Env, and as process environment in the raster workers).
# Bounded on purpose (see tools/trace_root_cause.py and the GDAL docs, gdal.org/en/stable/user/configoptions.html):
#  * GDAL_HTTP_RETRY_DELAY defaults to 30 s and grows x2 per retry: with the old 20 s timeout and 2 retries one stalled
#    request took 70-165 s (the "80 s reads" in cog_timing.log). Now: 10 s per request, abort below 10 kB/s for 5 s,
#    one retry after 1 s -> ~21 s worst case per HTTP request.
#  * VSI_CACHE_SIZE is per open file handle and duplicates /vsicurl/'s own cache: off. CPL_VSIL_CURL_CACHE_SIZE (bytes) is
#    one LRU per process, kept for the life of the process: 64 MB. GDAL_CACHEMAX (MB): 64 (blocks of a closed dataset are dropped anyway). The old 512 MB + 256 MB per
#    handle + 256 MB, in each of three workers, could take gigabytes of a laptop's commit.
GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.TIF,.tiff,.TIFF,.img,.IMG,.lbl,.LBL",
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_TIMEOUT": "10",
    "GDAL_HTTP_CONNECTTIMEOUT": "5",
    "GDAL_HTTP_LOW_SPEED_TIME": "5",
    "GDAL_HTTP_LOW_SPEED_LIMIT": "10240",
    "GDAL_HTTP_MAX_RETRY": "1",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "GDAL_HTTP_USERAGENT": UA,
    "VSI_CACHE": "FALSE",
    "GDAL_CACHEMAX": 64,                      # MB; rasterio wants an integer here (a string raises "an integer is required")
    "CPL_VSIL_CURL_CACHE_SIZE": str(64 * 1024 * 1024),
    "GDAL_BAND_BLOCK_CACHE": "HASHSET",
}
if CA_FILE:
    GDAL_ENV["CURL_CA_BUNDLE"] = CA_FILE
    os.environ.setdefault("CURL_CA_BUNDLE", CA_FILE)
    os.environ.setdefault("SSL_CERT_FILE", CA_FILE)


class Offline(OSError):
    """Raised instead of touching the network: Mars mode is on (no Earth link), or the internet was just found to be
    unreachable. Callers fall back to the data stored on this computer (planet/localmode.py)."""


# what Mars mode refused, and what was served from the PC instead: the proof shown in the Local mode panel
COUNTERS = {"blocked": 0, "blocked_hosts": {}, "fetched": 0, "since": time.time()}
NO_NET_RETRY_S = 30          # after a failed internet check, remote reads fail at once for this long (no hanging tiles)


def _host(url: str) -> str:
    try:
        return url.split("/")[2]
    except IndexError:
        return url


def blocked(url: str = "") -> bool:
    """True when nothing may go out: Mars mode is on, or the last internet check (under 30 s ago) failed."""
    from . import localmode
    if localmode.offline():
        return True
    with _lock:
        return _state["online"] is False and time.time() - _state["checked"] < NO_NET_RETRY_S


def _guard(url: str) -> None:
    from . import localmode
    if localmode.offline():
        with _lock:
            COUNTERS["blocked"] += 1
            h = _host(url)
            COUNTERS["blocked_hosts"][h] = COUNTERS["blocked_hosts"].get(h, 0) + 1
        raise Offline(f"Mars mode: no Earth link (refused {_host(url)})")
    if blocked(url):
        raise Offline(f"no internet connection ({_host(url)} not tried; checked under {NO_NET_RETRY_S} s ago)")


def get(url: str, timeout: float = 30, retries: int = 2, headers: dict | None = None) -> bytes:
    _guard(url)
    last = None
    for k in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
                data = r.read()
            _mark(True)
            COUNTERS["fetched"] += 1
            return data
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404, 410):
                raise
            last = e
        except Exception as e:  # noqa: BLE001 - network errors of every kind
            last = e
        time.sleep(0.8 * (k + 1))
    _mark(False, last)
    raise last


def get_json(url: str, timeout: float = 30, retries: int = 2):
    return json.loads(get(url, timeout, retries, {"Accept": "application/json, application/geo+json"}).decode("utf-8"))


def head(url: str, timeout: float = 20) -> int | None:
    """Size in bytes of a remote file (HTTP HEAD, Content-Length), or None if the server does not say."""
    _guard(url)
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
            n = r.headers.get("Content-Length")
            return int(n) if n else None
    except urllib.error.HTTPError as e:
        if e.code in (403, 405):          # some servers refuse HEAD: ask for one byte instead
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-0"})
            with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
                cr = r.headers.get("Content-Range", "")
                return int(cr.rsplit("/", 1)[-1]) if "/" in cr and cr.rsplit("/", 1)[-1].isdigit() else None
        raise


class _FileLock:
    """Exclusive lock on a small <file>.lock next to a download, shared by every MarsNav process (the server, its raster
    workers and the job processes all download through here). It is an operating-system lock (LockFileEx on Windows,
    flock elsewhere), so it is released by the OS if the process holding it is killed: no stale lock can block the app.
    The lock file itself stays (0 bytes); deleting it while another process waits on it would let two holders in."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.f = None

    def _try(self) -> bool:
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def acquire(self, timeout: float, cancel=None) -> bool:
        self.f = open(self.path, "a+b")
        t0 = time.time()
        while not self._try():
            if time.time() - t0 > timeout or (cancel is not None and cancel()):
                self.f.close()
                self.f = None
                return False
            time.sleep(0.2)
        return True

    def release(self) -> None:
        if self.f is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self.f.close()
            self.f = None


_dl_guard = threading.Lock()
_dl_locks: dict[str, threading.Lock] = {}
DOWNLOAD_WAIT_S = 900        # how long a caller waits for another thread or process that is fetching the same file


def _complete(dest: Path, expected: int | None) -> bool:
    return dest.exists() and (expected is None or dest.stat().st_size == expected)


def download(url: str, dest: Path, progress=None, expected: int | None = None, timeout: float = 60, resume: bool = True,
             cancel=None, hasher=None) -> Path:
    """Stream url to dest (via dest.part, renamed when complete). progress(done_bytes, total_bytes). An interrupted
    download continues where it stopped (HTTP Range) when the server allows it. cancel() -> True stops it (the .part file
    stays, for the next attempt). hasher (hashlib object) is fed every byte of the finished file.

    One download per file at a time, across threads and processes: on a first run several map tiles, a route job and a
    raster worker can all need the same 33 MB elevation file at once. They used to write the same .part file together
    (one truncating while another appended), so every copy failed its size check. Now the first caller downloads and the
    others wait for it, then use the finished file."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if _complete(dest, expected):
        return dest
    _guard(url)
    with _dl_guard:
        tlock = _dl_locks.setdefault(str(dest.resolve()).lower(), threading.Lock())
    t0 = time.time()
    while not tlock.acquire(timeout=0.5):
        if cancel is not None and cancel():
            raise InterruptedError("download cancelled")
        if time.time() - t0 > DOWNLOAD_WAIT_S:
            raise TimeoutError(f"{dest.name}: still being downloaded by another request after {DOWNLOAD_WAIT_S} s")
    try:
        flock = _FileLock(dest.with_suffix(dest.suffix + ".lock"))
        if not flock.acquire(max(1.0, DOWNLOAD_WAIT_S - (time.time() - t0)), cancel):
            if cancel is not None and cancel():
                raise InterruptedError("download cancelled")
            raise TimeoutError(f"{dest.name}: still being downloaded by another MarsNav process after {DOWNLOAD_WAIT_S} s")
        try:
            if _complete(dest, expected):      # finished by whoever held the lock before us
                return dest
            return _download(url, dest, progress, expected, timeout, resume, cancel, hasher)
        finally:
            flock.release()
    finally:
        tlock.release()


def _download(url: str, dest: Path, progress, expected, timeout, resume, cancel, hasher) -> Path:
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if (resume and part.exists()) else 0
    if expected and have > expected:
        have = 0
    hdr = {"User-Agent": UA}
    if have:
        hdr["Range"] = f"bytes={have}-"
    req = urllib.request.Request(url, headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
            ranged = have and r.status == 206
            if not ranged:
                have = 0
            total = int(r.headers.get("Content-Length") or 0) + have or (expected or 0)
            if hasher is not None and have:
                with open(part, "rb") as f0:
                    while True:
                        b = f0.read(1 << 22)
                        if not b:
                            break
                        hasher.update(b)
            with open(part, "ab" if ranged else "wb") as f:
                done = have
                while True:
                    if cancel is not None and cancel():
                        raise InterruptedError("download cancelled")
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
                    if hasher is not None:
                        hasher.update(b)
                    done += len(b)
                    if progress:
                        progress(done, total)
        _mark(True)
        COUNTERS["fetched"] += 1
    except InterruptedError:
        raise
    except Exception as e:  # noqa: BLE001
        _mark(False, e)
        raise
    if expected and part.stat().st_size != expected:
        raise IOError(f"download of {url} is {part.stat().st_size} bytes, expected {expected}")
    os.replace(part, dest)
    return dest


def _mark(ok: bool, err=None):
    """Record the outcome of a request. A success proves the internet is up. A failure proves only that one server did not
    answer (swim.psi.edu or the USGS map service can be down while NASA and USGS data servers are fine), so it does not
    declare the app offline: it makes the next online() check probe the USGS STAC server again instead."""
    with _lock:
        if ok:
            _state["online"] = True
            _state["checked"] = time.time()
        else:
            _state["checked"] = 0.0
            if err is not None:
                _state["last_error"] = f"{type(err).__name__}: {err}"[:300]


_probe_lock = threading.Lock()


def online(max_age: float = 120) -> bool:
    """Is the internet (NASA/USGS) reachable? A success is trusted for max_age seconds, a failure for 30 s; one thread
    probes, the others use the last answer. Always False in Mars mode (nothing is sent)."""
    from . import localmode
    if localmode.offline():
        return False
    with _lock:
        age = time.time() - _state["checked"]
        limit = max_age if _state["online"] else NO_NET_RETRY_S
        if _state["online"] is not None and age < limit:
            return bool(_state["online"])
        last = _state["online"]
    if not _probe_lock.acquire(blocking=False):
        return bool(last) if last is not None else True
    try:
        req = urllib.request.Request("https://stac.astrogeology.usgs.gov/api/", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=8, context=_ctx) as r:
            r.read(1024)
        ok = True
    except Exception as e:  # noqa: BLE001
        ok = False
        with _lock:
            _state["last_error"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        _probe_lock.release()
    with _lock:
        _state["online"] = ok
        _state["checked"] = time.time()
    return ok


def status() -> dict:
    from . import localmode
    with _lock:
        out = dict(_state)
    out["mars_mode"] = localmode.offline()
    out["counters"] = {k: (dict(v) if isinstance(v, dict) else v) for k, v in COUNTERS.items()}
    return out


def vsi(url: str) -> str:
    return url if url.startswith("/vsi") else "/vsicurl/" + url
