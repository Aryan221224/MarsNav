"""Read any raster (a local file, or a cloud-optimised GeoTIFF on a NASA/USGS server) onto a lon/lat grid.
Only the window under the request is fetched (GDAL /vsicurl/ HTTP range requests); an overview level is used when the
request is coarser than the data, so a small map tile never pulls a full-resolution strip."""
from __future__ import annotations

import json
import threading
import time

import numpy as np

from . import net
from .config import PATHS

GEO_WKT = ('GEOGCS["GCS_Mars_2000_Sphere",DATUM["Mars_2000_(Sphere)",SPHEROID["Mars_2000_Sphere",3396190,0]],'
           'PRIMEM["Reference_Meridian",0],UNIT["degree",0.0174532925199433]]')

_probe_lock = threading.Lock()
# One thread at a time inside GDAL. rasterio keeps the Python GIL while closing a dataset and some GDAL calls, and
# GDAL calls back into Python (error logging) while holding its own mutexes: two threads using GDAL at once can
# deadlock the whole process (every request, even /api/ping, then hangs). Waiting on this lock releases the GIL, so
# the rest of the server keeps running. Long pipeline jobs run in a separate process (jobs.start_process).
GDAL_LOCK = threading.RLock()


class _Steps:
    """Diagnostics: time each step of a remote read; calls slower than 3 s are logged to data_cache/cog_timing.log."""

    def __init__(self, url):
        self.url, self.t0, self.last, self.steps = url, time.time(), time.time(), []

    def __call__(self, label):
        now = time.time()
        self.steps.append(f"{label} {now - self.last:.2f}s")
        self.last = now

    def done(self):
        tot = time.time() - self.t0
        if tot > 3:
            try:
                with open(PATHS["cache"].parent / "cog_timing.log", "a", encoding="utf-8") as f:
                    f.write(f"{time.strftime('%H:%M:%S')} {tot:.1f}s {self.url.rsplit('/', 1)[-1]}: {', '.join(self.steps)}\n")
            except OSError:
                pass


def _gdal_locked(fn):
    import functools

    @functools.wraps(fn)
    def run(*a, **k):
        with GDAL_LOCK:
            return fn(*a, **k)
    return run
_probes: dict[str, dict] = {}


def _rio():
    import rasterio  # noqa: F401  (imported lazily: the static app must work even without GDAL)
    from rasterio.warp import reproject, Resampling, transform_bounds
    from rasterio.windows import from_bounds, Window
    from affine import Affine
    return rasterio, reproject, Resampling, transform_bounds, from_bounds, Window, Affine


def _open(url: str, **kw):
    """Open a raster: the complete local copy when Local mode has downloaded it, else the remote file over HTTP range
    requests; in Mars mode (or with no internet) a file that is not on this computer raises net.Offline at once."""
    rasterio = _rio()[0]
    if url.startswith("http"):
        from . import localmode
        lf = localmode.local_file(url)
        if lf is not None:
            return rasterio.open(str(lf), **kw)
        net._guard(url)
        return rasterio.open(net.vsi(url), **kw)
    return rasterio.open(url, **kw)


@_gdal_locked
def _probe_gdal(url: str) -> dict:
    rasterio = _rio()[0]
    with rasterio.Env(**net.GDAL_ENV):
        with _open(url) as src:
            bw, bh = src.block_shapes[0]
            return {"t": time.time(), "width": src.width, "height": src.height, "block": [bw, bh],
                    "overviews": src.overviews(1), "crs": src.crs.to_wkt() if src.crs else None,
                    "res": abs(src.transform.a), "nodata": src.nodata, "dtype": src.dtypes[0],
                    "tiled": bh < src.height and bw < src.width}


def _remote(name: str, *args, **kwargs):
    """Run cog.<name> in a raster worker process when the server uses them (planet/workers.py), else here."""
    from . import workers
    if workers.enabled():
        return workers.call(f"planet.cog:{name}", *args, **kwargs)
    return globals()[name](*args, **kwargs)


def probe(url: str) -> dict:
    """Size, block layout and overviews of a raster (cached on disk): tells whether windowed streaming is efficient."""
    from . import localmode
    if url.startswith("http") and localmode.local_file(url) is None:
        net._guard(url)
    with _probe_lock:
        if url in _probes:
            return _probes[url]
    cache = PATHS["catalog"] / "probes.json"
    try:
        disk = json.loads(cache.read_text()) if cache.exists() else {}
    except (OSError, ValueError):
        disk = {}
    if url in disk and time.time() - disk[url].get("t", 0) < 30 * 86400:
        with _probe_lock:
            _probes[url] = disk[url]
        return disk[url]
    info = _remote("_probe_gdal", url)
    info["streamable"] = info["tiled"] or info["block"][1] <= 16
    disk[url] = info
    try:
        cache.write_text(json.dumps(disk))
    except OSError:
        pass
    with _probe_lock:
        _probes[url] = info
    return info


@_gdal_locked
def _read_lonlat_local(url: str, w: float, s: float, e: float, n: float, nx: int, ny: int, *, vertex: bool = True,
                band: int = 1, resampling: str = "bilinear", valid_range=(-1e4, 3e4), dtype="float32") -> np.ndarray | None:
    """Raster values on a lon/lat grid over (w, s, e, n). vertex=True: nx x ny samples at the corners-inclusive lattice
    (elevation tiles); vertex=False: pixel-is-area cells (imagery tiles). NaN where the source has no data. Returns None
    when the source does not cover the box at all."""
    rasterio, reproject, Resampling, transform_bounds, from_bounds, Window, Affine = _rio()
    if vertex:
        dx, dy = (e - w) / (nx - 1), (n - s) / (ny - 1)
        dst_t = Affine(dx, 0, w - dx / 2, 0, -dy, n + dy / 2)
    else:
        dx, dy = (e - w) / nx, (n - s) / ny
        dst_t = Affine(dx, 0, w, 0, -dy, n)
    rs = getattr(Resampling, resampling)
    out = np.full((ny, nx), np.nan, np.float32)
    st = _Steps(url)
    try:
        return _read_lonlat(url, w, s, e, n, nx, ny, dx, dy, dst_t, rs, band, valid_range, out, st)
    finally:
        st.done()


def _read_lonlat(url, w, s, e, n, nx, ny, dx, dy, dst_t, rs, band, valid_range, out, st):
    rasterio, reproject, Resampling, transform_bounds, from_bounds, Window, Affine = _rio()
    with rasterio.Env(**net.GDAL_ENV):
        st("env")
        with _open(url) as src:
            st("open")
            tb = transform_bounds(GEO_WKT, src.crs, w - dx, max(-90, s - dy), e + dx, min(90, n + dy), densify_pts=21)
            st("bounds")
            sb = src.bounds
            if tb[2] < sb.left or tb[0] > sb.right or tb[3] < sb.bottom or tb[1] > sb.top:
                return None
            src_res = abs(src.transform.a)
            want = max((tb[2] - tb[0]) / nx, (tb[3] - tb[1]) / ny)
            level = None
            for k, f in enumerate(src.overviews(band)):
                if src_res * f <= want * 1.001:
                    level = k
            st(f"overviews(level {level})")
            ds = _open(url, overview_level=level) if level is not None else None
            st("open-overview")
            try:
                S = ds or src
                win = from_bounds(*tb, transform=S.transform).round_offsets().round_lengths()
                win = Window(win.col_off - 2, win.row_off - 2, win.width + 4, win.height + 4)
                win = win.intersection(Window(0, 0, S.width, S.height))
                if win.width < 1 or win.height < 1:
                    return None
                data = S.read(band, window=win).astype(np.float32)
                st(f"read {int(win.width)}x{int(win.height)}")
                nod = S.nodata
                bad = ~np.isfinite(data)
                if nod is not None:
                    bad |= data == nod
                if valid_range:
                    bad |= (data < valid_range[0]) | (data > valid_range[1])
                data[bad] = np.nan
                sc, off = (S.scales or [1.0])[band - 1] or 1.0, (S.offsets or [0.0])[band - 1] or 0.0
                if sc != 1.0 or off != 0.0:
                    data = data * sc + off
                if not np.isfinite(data).any():
                    return None
                reproject(data, out, src_transform=S.window_transform(win), src_crs=S.crs, src_nodata=np.nan,
                          dst_transform=dst_t, dst_crs=GEO_WKT, dst_nodata=np.nan, resampling=rs)
                st("reproject")
            finally:
                if ds is not None:
                    ds.close()
                    st("close-overview")
        st("close")
    if not np.isfinite(out).any():
        return None
    return out


@_gdal_locked
def _clip_to_file_local(url: str, dest, w: float, s: float, e: float, n: float, pad_deg: float = 0.0) -> dict | None:
    """Copy the window of a remote raster that covers a lon/lat box into a local GeoTIFF, keeping its own projection and
    full resolution (used to bring HiRISE / CTX DTMs into a site's raw folder). Returns {path, width, height, res}."""
    rasterio, reproject, Resampling, transform_bounds, from_bounds, Window, Affine = _rio()
    with rasterio.Env(**net.GDAL_ENV):
        with _open(url) as src:
            tb = transform_bounds(GEO_WKT, src.crs, w - pad_deg, s - pad_deg, e + pad_deg, n + pad_deg, densify_pts=21)
            win = from_bounds(*tb, transform=src.transform).round_offsets().round_lengths()
            win = win.intersection(Window(0, 0, src.width, src.height))
            if win.width < 8 or win.height < 8:
                return None
            data = src.read(1, window=win)
            prof = src.profile.copy()
            prof.update(driver="GTiff", width=int(win.width), height=int(win.height), transform=src.window_transform(win),
                        tiled=True, blockxsize=256, blockysize=256, compress="deflate", predictor=2 if data.dtype.kind == "f" else 1,
                        BIGTIFF="IF_SAFER")
            for k in ("photometric", "interleave"):
                prof.pop(k, None)
            with rasterio.open(dest, "w", **prof) as dst:
                dst.write(data, 1)
            return {"path": str(dest), "width": int(win.width), "height": int(win.height), "res": abs(src.transform.a)}


@_gdal_locked
def _read_grid_local(url: str, dst_wkt: str, dst_transform, nx: int, ny: int, *, band: int = 1, resampling: str = "bilinear",
              valid_range=(-1e4, 3e4)) -> np.ndarray | None:
    """Like read_lonlat, onto any projected grid (a site's working projection): window + overview chosen automatically."""
    rasterio, reproject, Resampling, transform_bounds, from_bounds, Window, Affine = _rio()
    if not hasattr(dst_transform, "c"):
        dst_transform = Affine(*dst_transform[:6])
    out = np.full((ny, nx), np.nan, np.float32)
    left, top = dst_transform.c, dst_transform.f
    right, bottom = left + dst_transform.a * nx, top + dst_transform.e * ny
    with rasterio.Env(**net.GDAL_ENV):
        with _open(url) as src:
            tb = transform_bounds(dst_wkt, src.crs, left, bottom, right, top, densify_pts=21)
            sb = src.bounds
            if tb[2] < sb.left or tb[0] > sb.right or tb[3] < sb.bottom or tb[1] > sb.top:
                return None
            src_res = abs(src.transform.a)
            want = max((tb[2] - tb[0]) / nx, (tb[3] - tb[1]) / ny)
            level = None
            for k, f in enumerate(src.overviews(band)):
                if src_res * f <= want * 1.001:
                    level = k
            ds = _open(url, overview_level=level) if level is not None else None
            try:
                S = ds or src
                win = from_bounds(*tb, transform=S.transform).round_offsets().round_lengths()
                win = Window(win.col_off - 2, win.row_off - 2, win.width + 4, win.height + 4).intersection(Window(0, 0, S.width, S.height))
                if win.width < 1 or win.height < 1:
                    return None
                data = S.read(band, window=win).astype(np.float32)
                bad = ~np.isfinite(data)
                if S.nodata is not None:
                    bad |= data == S.nodata
                if valid_range:
                    bad |= (data < valid_range[0]) | (data > valid_range[1])
                data[bad] = np.nan
                sc, off = (S.scales or [1.0])[band - 1] or 1.0, (S.offsets or [0.0])[band - 1] or 0.0
                if sc != 1.0 or off != 0.0:
                    data = data * sc + off
                if not np.isfinite(data).any():
                    return None
                reproject(data, out, src_transform=S.window_transform(win), src_crs=S.crs, src_nodata=np.nan,
                          dst_transform=dst_transform, dst_crs=dst_wkt, dst_nodata=np.nan, resampling=getattr(Resampling, resampling))
            finally:
                if ds is not None:
                    ds.close()
    return out if np.isfinite(out).any() else None


def read_lonlat(url, w, s, e, n, nx, ny, **kw):
    """See _read_lonlat_local; runs in a raster worker process when the server uses them."""
    return _remote("_read_lonlat_local", url, w, s, e, n, nx, ny, **kw)


def clip_to_file(url, dest, w, s, e, n, pad_deg=0.0):
    return _remote("_clip_to_file_local", url, str(dest), w, s, e, n, pad_deg=pad_deg)


def read_grid(url, dst_wkt, dst_transform, nx, ny, **kw):
    return _remote("_read_grid_local", url, dst_wkt, tuple(dst_transform)[:6], nx, ny, **kw)
