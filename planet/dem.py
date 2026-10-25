"""Elevation tiles: 257 x 257 heights (metres above the Mars areoid) at the corners-inclusive lattice of each tile, from
the best real source at that place and zoom, blended so the joins do not show. Encoded compactly for the browser."""
from __future__ import annotations

import gzip
import json
import struct
import time

import numpy as np

from . import catalog, cog, megdr, tilecache
from .config import DEM_N, R_MARS
from .tiling import bounds, tile_deg, valid

BLEND_URL = "https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
BLEND_CITE = ("Fergason, R.L., Hare, T.M., Laura, J. 2018, HRSC and MOLA Blended Digital Elevation Model at 200m v2, "
              "USGS Astrogeology Science Center, PDS Annex")
SOURCES = {
    "megdr16": {"name": "MOLA MEGDR 16 ppd", "res_m": 3705, "cite": megdr.CITATION},
    "megdr128": {"name": "MOLA MEGDR 128 ppd", "res_m": 463, "cite": megdr.CITATION},
    "blend200": {"name": "MOLA-HRSC blended DEM 200 m", "res_m": 200, "cite": BLEND_CITE},
    "ctx": {"name": "CTX stereo DTM 20 m", "res_m": 20, "cite": catalog.CITATION["ctx"]},
    "hirise": {"name": "HiRISE stereo DTM 1 m", "res_m": 1, "cite": catalog.CITATION["hirise"]},
}
_blend_state = {"ok": None, "why": None, "t": 0.0}


def blend_usable() -> bool:
    """The 200 m blend is an 11 GB file; stream windows from it only if it is laid out for it (tiled / small strips), or
    read it from the complete local copy Local mode downloads."""
    from . import localmode
    if localmode.local_file(BLEND_URL) is not None:
        return True
    if _blend_state["ok"] is not None and time.time() - _blend_state["t"] < 3600:
        return _blend_state["ok"]
    try:
        info = cog.probe(BLEND_URL)
        ok = bool(info.get("streamable"))
        _blend_state.update(ok=ok, why=None if ok else f"stored as {info.get('block')} blocks: too slow to stream", t=time.time())
    except Exception as e:  # noqa: BLE001
        _blend_state.update(ok=False, why=f"{type(e).__name__}: {e}", t=time.time())
    return _blend_state["ok"]


def feather_merge(base: np.ndarray, hi: np.ndarray, feather_px: int = 6) -> np.ndarray:
    """hi over base where hi has data; the weight ramps up over feather_px from hi's edge, and hi's mean offset from base
    (small: CTX and HiRISE DTMs are controlled to MOLA) is removed near the edge, so no step appears at the join."""
    from scipy import ndimage as ndi
    m = np.isfinite(hi)
    if not m.any():
        return base
    ok = m & np.isfinite(base)
    if ok.sum() > 50:
        off = float(np.median((hi - base)[ok]))
    else:
        off = 0.0
    d = ndi.distance_transform_edt(m)
    w = np.clip(d / max(1, feather_px), 0, 1)
    hi_adj = np.where(m, hi - off * (1 - w), np.nan)
    out = base.copy()
    fill = m & ~np.isfinite(base)
    out[fill] = hi_adj[fill]
    both = m & np.isfinite(base)
    out[both] = w[both] * hi_adj[both] + (1 - w[both]) * base[both]
    return out


def build(z: int, y: int, x: int, detail: bool = True) -> tuple[np.ndarray, dict]:
    if not valid(z, y, x):
        raise ValueError("tile out of range")
    w, s, e, n = bounds(z, y, x)
    lons = np.linspace(w, e, DEM_N)
    lats = np.linspace(n, s, DEM_N)
    LON, LAT = np.meshgrid(lons, lats)
    used = []
    base = None
    provisional = False      # built from a stand-in while better data is still downloading: do not cache it
    from . import localmode, net
    lb = localmode.blend() if z >= 6 else None
    if lb is not None:
        base = lb.sample(LON, LAT)                     # the local 11 GB file, memory-mapped: no network, no GDAL
        used.append(["blend200", float(np.isfinite(base).mean())])
    elif z >= 5 and blend_usable():
        try:
            base = cog.read_lonlat(BLEND_URL, w, s, e, n, DEM_N, DEM_N, vertex=True, resampling="bilinear" if z >= 8 else "average")
            if base is not None:
                used.append(["blend200", float(np.isfinite(base).mean())])
        except Exception as ex:  # noqa: BLE001
            _blend_state.update(ok=False, why=f"{type(ex).__name__}: {ex}", t=time.time())
            base = None
            provisional = True
    if base is None or not np.isfinite(base).all():
        if z >= 6:
            # 463 m MOLA: the 130 MB quadrant files under this tile download in the background (once); until they are
            # here the tile uses the 3.7 km global grid and is marked provisional, so it is rebuilt when they arrive
            need = megdr.tiles_for(w, s, e, n)
            missing = [t for t in need if not megdr.have(t)]
            for t in missing:
                megdr.fetch_async(t)
            provisional = provisional or bool(missing)
            fb = megdr.sample128(LON, LAT, allow_download=False)
            src = "megdr128" if len(missing) < len(need) else "megdr16"
        else:
            fb = megdr.sample16(LON, LAT)
            src = "megdr16"
        if base is None:
            base = fb
            used.append([src, 1.0])
        else:
            gap = ~np.isfinite(base)
            base[gap] = fb[gap]
            used.append([src, float(gap.mean())])
    if detail and z >= 10:
        for kind, zmin, lim in (("ctx", 10, 8), ("hirise", 13, 6)):
            if z < zmin:
                continue
            if not catalog.ready(kind):
                provisional = True          # the footprint catalogue is still downloading
                catalog.load(kind)          # (starts it in the background if needed)
            got = None
            for it in catalog.query(kind, w, s, e, n, limit=lim):
                try:
                    a = cog.read_lonlat(it["dtm"], w, s, e, n, DEM_N, DEM_N, vertex=True)
                except net.Offline:
                    continue                # Mars mode: this product is not in the local packs
                except Exception:  # noqa: BLE001 - one bad product must not break the tile
                    provisional = True      # (network timeout or error: build it again later rather than cache it)
                    continue
                if a is None:
                    continue
                got = a if got is None else np.where(np.isfinite(got), got, a)
            if got is not None:
                frac = float(np.isfinite(got).mean())
                base = feather_merge(base, got, feather_px=6)
                used.append([kind, frac])
    finest = min((SOURCES[k]["res_m"] for k, f in used if f > 0.02), default=3705)
    meta = {"z": z, "y": y, "x": x, "bbox": [w, s, e, n], "sources": [{"id": k, "name": SOURCES[k]["name"], "res_m": SOURCES[k]["res_m"],
            "frac": round(f, 3)} for k, f in used], "finest_m": finest, "tile_m": round(tile_deg(z) / (DEM_N - 1) * np.pi / 180 * R_MARS, 2)}
    if provisional and not net.blocked():
        meta["provisional"] = True          # (in Mars mode the local data is all there will be: the tile is final)
    if net.blocked():
        meta["offline"] = True
    return base.astype(np.float32), meta


def encode(elev: np.ndarray, meta: dict) -> bytes:
    """MMD1: magic, uint16 N, uint16 flags, float32 min, float32 scale, uint32 meta length, meta JSON, pad to 2 bytes,
    then N*N uint16 (little-endian, row-major from the north-west corner; 65535 = no data). Gzip-compressed."""
    v = np.isfinite(elev)
    lo = float(np.nanmin(elev)) if v.any() else 0.0
    hi = float(np.nanmax(elev)) if v.any() else 0.0
    scale = max((hi - lo) / 65534.0, 1e-4)
    q = np.where(v, np.round((np.nan_to_num(elev, nan=lo) - lo) / scale), 65535).astype("<u2")
    mb = json.dumps(meta, separators=(",", ":")).encode()
    head = b"MMD1" + struct.pack("<HHffI", elev.shape[0], 0, lo, scale, len(mb)) + mb
    if len(head) % 2:
        head += b" "
    return gzip.compress(head + q.tobytes(), compresslevel=6)


def decode(blob: bytes) -> tuple[np.ndarray, dict]:
    raw = gzip.decompress(blob)
    assert raw[:4] == b"MMD1"
    n, _flags, lo, scale, ml = struct.unpack("<HHffI", raw[4:20])
    meta = json.loads(raw[20:20 + ml])
    off = 20 + ml + ((20 + ml) % 2)
    q = np.frombuffer(raw[off:off + n * n * 2], dtype="<u2").reshape(n, n)
    return np.where(q == 65535, np.nan, lo + q.astype(np.float32) * scale), meta


def tile_bytes_ex(z: int, y: int, x: int) -> tuple[bytes, bool]:
    """(tile bytes, final). A provisional tile (better data still downloading) is served but not cached."""
    key, _off = tilecache.lookup("dem", z, y, x, "mmd")
    if key.exists():
        return tilecache.get_or_build(key, None), True
    box = {}

    def make():
        elev, meta = build(z, y, x)
        box["prov"] = bool(meta.get("provisional"))
        data = encode(elev, meta)
        if box["prov"]:
            raise _Provisional(data)
        return data
    try:
        return tilecache.get_or_build(key, make), True
    except _Provisional as p:
        return p.data, False


class _Provisional(Exception):
    def __init__(self, data):
        super().__init__("provisional tile")
        self.data = data


def tile_bytes(z: int, y: int, x: int) -> bytes:
    return tile_bytes_ex(z, y, x)[0]


def tile(z: int, y: int, x: int) -> tuple[np.ndarray, dict]:
    return decode(tile_bytes(z, y, x))


def mosaic(z: int, w: float, s: float, e: float, n: float, progress=None) -> tuple[np.ndarray, np.ndarray, np.ndarray, list]:
    """Stitch elevation tiles of zoom z over a lon/lat box (longitudes may run past +-180: tiles wrap). Returns
    (Z, lons, lats, metas) with Z[row, col] at lats[row] (north first) and lons[col]."""
    from .tiling import ntiles
    d = tile_deg(z)
    step = d / (DEM_N - 1)
    cols_n, rows_n = ntiles(z)
    x0, x1 = int(np.floor((w + 180) / d)), int(np.floor((e + 180 - 1e-9) / d))
    y0, y1 = max(0, int(np.floor((90 - n) / d))), min(rows_n - 1, int(np.floor((90 - s - 1e-9) / d)))
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    Z = np.full((ny * (DEM_N - 1) + 1, nx * (DEM_N - 1) + 1), np.nan, np.float32)
    metas = []
    k = 0
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            a, m = tile(z, ty, tx % cols_n)
            metas.append(m)
            r0, c0 = (ty - y0) * (DEM_N - 1), (tx - x0) * (DEM_N - 1)
            Z[r0:r0 + DEM_N, c0:c0 + DEM_N] = a
            k += 1
            if progress:
                progress(k, nx * ny)
    lons = -180 + x0 * d + np.arange(Z.shape[1]) * step
    lats = 90 - y0 * d - np.arange(Z.shape[0]) * step
    return Z, lons, lats, metas


def point(lon: float, lat: float, z: int = 12) -> dict:
    """Best elevation at a point, the source it came from, and slope at the tile's resolution."""
    from .tiling import tile_of
    ty, tx = tile_of(lon, lat, z)
    a, m = tile(z, ty, tx)
    w, s, e, n = m["bbox"]
    fx = (lon - w) / (e - w) * (DEM_N - 1)
    fy = (n - lat) / (n - s) * (DEM_N - 1)
    c, r = int(round(fx)), int(round(fy))
    c, r = min(DEM_N - 2, max(1, c)), min(DEM_N - 2, max(1, r))
    dy = (n - s) / (DEM_N - 1) * np.pi / 180 * R_MARS
    dx = dy * max(0.01, np.cos(np.radians(lat)))
    gx = (a[r, c + 1] - a[r, c - 1]) / (2 * dx)
    gy = (a[r - 1, c] - a[r + 1, c]) / (2 * dy)
    return {"lon": lon, "lat": lat, "elev_m": float(a[r, c]), "slope_deg": float(np.degrees(np.arctan(np.hypot(gx, gy)))),
            "baseline_m": round(2 * dy, 1), "sources": m["sources"], "finest_m": m["finest_m"], "z": z}
