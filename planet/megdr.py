"""MOLA Mission Experiment Gridded Data Records (MGS laser altimeter), NASA PDS Geosciences Node.

The whole-planet elevation base. Raw PDS images: signed 16-bit big-endian metres relative to the areoid, one row per
line from the north edge, longitudes 0-360 east, pixel-is-area.
  meg016/megt90n000eb.img   16 ppd (3.7 km), 90N-90S, one 33 MB file: the entire planet
  meg128/megt{88n,44n,00n,44s}{000,090,180,270}hb.img   128 ppd (463 m), 16 files of 130 MB covering 88N-88S
Read with numpy memory maps, sampled bilinearly (no GDAL needed, so the planet works even if GDAL cannot)."""
from __future__ import annotations

import math
import threading
from pathlib import Path

import numpy as np

from . import net
from .config import PATHS

BASE = "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/"
G16 = {"key": "megt90n000eb", "url": BASE + "meg016/megt90n000eb.img", "rows": 2880, "cols": 5760, "ppd": 16,
       "lat_top": 90.0, "lon0": 0.0, "bytes": 33177600}
T128 = []
for band, top in (("88n", 88.0), ("44n", 44.0), ("00n", 0.0), ("44s", -44.0)):
    for lon0 in (0, 90, 180, 270):
        key = f"megt{band}{lon0:03d}hb"
        T128.append({"key": key, "url": BASE + f"meg128/{key}.img", "rows": 5632, "cols": 11520, "ppd": 128,
                     "lat_top": top, "lon0": float(lon0), "bytes": 129761280})

CITATION = ("Smith, D. et al., MGS MOLA Mission Experiment Gridded Data Records, MGS-M-MOLA-5-MEGDR-L3-V1.0, "
            "NASA Planetary Data System, 2003")
_maps: dict[str, np.memmap] = {}
_lock = threading.Lock()


def path_of(info: dict) -> Path:
    return PATHS["base"] / f"{info['key']}.img"


def have(info: dict) -> bool:
    p = path_of(info)
    return p.exists() and p.stat().st_size == info["bytes"]


def ensure(info: dict, progress=None) -> np.memmap:
    with _lock:
        if info["key"] in _maps:
            return _maps[info["key"]]
    if not have(info):
        net.download(info["url"], path_of(info), progress=progress, expected=info["bytes"], timeout=120)
    mm = np.memmap(path_of(info), dtype=">i2", mode="r", shape=(info["rows"], info["cols"]))
    with _lock:
        _maps[info["key"]] = mm
    return mm


def _bilinear(arr, info, lon, lat, wrap: bool):
    ppd = info["ppd"]
    col = ((lon - info["lon0"]) % 360.0) * ppd - 0.5 if wrap else (lon - info["lon0"]) * ppd - 0.5
    row = (info["lat_top"] - lat) * ppd - 0.5
    row = np.clip(row, 0, info["rows"] - 1.000001)
    r0 = np.floor(row).astype(np.int64)
    fr = row - r0
    r1 = np.minimum(r0 + 1, info["rows"] - 1)
    if wrap:
        c0f = np.floor(col)
        fc = col - c0f
        c0 = c0f.astype(np.int64) % info["cols"]
        c1 = (c0 + 1) % info["cols"]
    else:
        col = np.clip(col, 0, info["cols"] - 1.000001)
        c0 = np.floor(col).astype(np.int64)
        fc = col - c0
        c1 = np.minimum(c0 + 1, info["cols"] - 1)
    a = arr[r0, c0].astype(np.float32)
    b = arr[r0, c1].astype(np.float32)
    c = arr[r1, c0].astype(np.float32)
    d = arr[r1, c1].astype(np.float32)
    return (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr


def sample16(lon, lat, progress=None) -> np.ndarray:
    lon = np.asarray(lon, np.float64)
    lat = np.asarray(lat, np.float64)
    arr = ensure(G16, progress)
    return _bilinear(arr, G16, lon, lat, wrap=True).astype(np.float32)


def tile128_for(lon: float, lat: float) -> dict | None:
    if abs(lat) > 88:
        return None
    lo = lon % 360.0
    for t in T128:
        if t["lat_top"] - 44.0 <= lat <= t["lat_top"] and t["lon0"] <= lo < t["lon0"] + 90.0:
            return t
    return None


def sample128(lon, lat, allow_download: bool = True, progress=None) -> np.ndarray:
    """463 m MOLA; points poleward of 88 deg (or in tiles not downloaded when allow_download is False) use 16 ppd."""
    lon = np.asarray(lon, np.float64)
    lat = np.asarray(lat, np.float64)
    out = np.full(lon.shape, np.nan, np.float32)
    lo = lon % 360.0
    for t in T128:
        m = (lat <= t["lat_top"]) & (lat >= t["lat_top"] - 44.0) & (lo >= t["lon0"]) & (lo < t["lon0"] + 90.0)
        if not m.any():
            continue
        if not have(t) and not allow_download:
            continue
        arr = ensure(t, progress)
        out[m] = _bilinear(arr, t, lo[m], lat[m], wrap=False)
    bad = ~np.isfinite(out)
    if bad.any():
        out[bad] = sample16(lon[bad], lat[bad])
    return out


def status() -> dict:
    return {"global16": have(G16), "tiles128": sum(have(t) for t in T128), "tiles128_total": len(T128), "downloading": sorted(_fetching)}


def tiles_for(w: float, s: float, e: float, n: float) -> list:
    """The 128 ppd quadrant files a lon/lat box touches (they cover 88 N to 88 S)."""
    out = []
    lo_w, lo_e = w % 360.0, e % 360.0
    for t in T128:
        top, bot = t["lat_top"], t["lat_top"] - 44.0
        if n < bot or s > top:
            continue
        a, b = t["lon0"], t["lon0"] + 90.0
        if e - w >= 360 or (lo_w <= lo_e and not (lo_e < a or lo_w >= b)) or (lo_w > lo_e and (lo_w < b or lo_e >= a)):
            out.append(t)
    return out


_fetching: set = set()


def fetch_async(info: dict) -> None:
    """Download one 128 ppd quadrant (130 MB) in the background, once."""
    with _lock:
        if info["key"] in _fetching or have(info):
            return
        _fetching.add(info["key"])

    def run():
        try:
            ensure(info)
        except Exception:  # noqa: BLE001 - offline: try again next time a tile needs it
            pass
        finally:
            with _lock:
                _fetching.discard(info["key"])
    threading.Thread(target=run, daemon=True, name=f"megdr-{info['key']}").start()
