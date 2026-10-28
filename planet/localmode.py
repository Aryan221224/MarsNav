"""Local mode: MarsNav as it would run on Mars, with no Earth link.

A crew 4 to 24 light-minutes from Earth cannot stream maps. Local mode downloads the data to this computer once, at the
native resolution each dataset was published at, and Mars mode then cuts the app off from the internet: every request
the engine would have sent is refused (and counted, as proof), and everything is served from the local copies.

What "full fidelity" means here, and why it is two kinds of pack:
  * Whole-planet packs: every global dataset the app uses, complete, at its native resolution: MOLA elevation (463 m and
    3.7 km), the HRSC + MOLA blended elevation (200 m, an 11 GB file), Viking colour (232 m) and MOLA colour relief,
    the USGS global geologic map, the science layers (SWIM ice, TES thermal inertia, GRS water, every crater >= 1 km),
    the HiRISE / CTX footprint catalogues and IAU names. Optionally THEMIS day / night infrared (100 m) for the whole
    planet (about 20 GB each).
  * Exploration-zone packs: around each landing site / hub, every high-resolution product that exists there, complete
    and untouched: each HiRISE 1 m elevation model and its 25-50 cm orthoimage, each CTX 20 m elevation model and its
    6 m orthoimage (the USGS cloud-optimised GeoTIFFs, byte for byte), the CTX global mosaic at its full 5 m, THEMIS
    infrared, and map tiles pre-rendered from all of it.
  The full-resolution HiRISE and CTX archives for the whole planet are hundreds of terabytes, which no laptop holds:
  a real crew carries the planet at global resolution and its exploration zone at full resolution, which is what this
  does. Sizes are measured (HTTP Content-Length) before anything is downloaded, against the free disk.

Files live in data_cache/planet/local/: files/<host>/<path> (exact copies of the remote files, found by URL through
manifest.json), tiles/<kind>/<z>/<y>/<x>.<ext> (never trimmed, unlike the rolling tile cache), mode.json (Mars mode on /
off), progress.json (the running install), geology_units.json. MOLA and the science layers keep their usual folders."""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from .config import PATHS, R_MARS

_lock = threading.Lock()


# ------------------------------------------------------------------ places

def root() -> Path:
    p = PATHS["cache"] / "local"
    p.mkdir(parents=True, exist_ok=True)
    return p


def tile_path(kind: str, z: int, y: int, x: int, ext: str) -> Path:
    return root() / "tiles" / kind / str(z) / str(y) / f"{x}.{ext}"


def file_dest(url: str) -> Path:
    """Where the local copy of a remote file goes: files/<host>/<path>, made safe for Windows."""
    rest = url.split("://", 1)[-1].split("?", 1)[0]
    parts = [p for p in rest.split("/") if p not in ("", ".", "..")]
    safe = ["".join(ch if (ch.isalnum() or ch in "._-") else "_" for ch in p)[:120] for p in parts]
    return root() / "files" / Path(*safe)


# ------------------------------------------------------------------ Mars mode (no Earth link)

_mode = {"checked": 0.0, "mtime": None, "offline": False, "since": None}


def offline() -> bool:
    """Mars mode on? Read from mode.json (shared by the server, its raster workers and job processes), at most once a
    second. MM_OFFLINE=1 forces it on."""
    if os.environ.get("MM_OFFLINE") == "1":
        return True
    now = time.time()
    if now - _mode["checked"] < 1.0:
        return _mode["offline"]
    _mode["checked"] = now
    if "cache" not in PATHS:
        return False
    f = PATHS["cache"] / "local" / "mode.json"
    try:
        mt = f.stat().st_mtime
    except OSError:
        _mode.update(offline=False, mtime=None, since=None)
        return False
    if mt != _mode["mtime"]:
        try:
            d = json.loads(f.read_text())
            _mode.update(offline=bool(d.get("offline")), since=d.get("since"), mtime=mt)
        except (OSError, ValueError):
            pass
    return _mode["offline"]


def set_offline(on: bool) -> dict:
    d = {"offline": bool(on), "since": time.time() if on else None, "changed": time.strftime("%Y-%m-%d %H:%M:%S")}
    f = root() / "mode.json"
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(d))
    os.replace(tmp, f)
    _mode["checked"] = 0.0
    if not on:
        clear_offline_tiles()          # tiles built without the internet are rebuilt at full quality when it is back
    from . import net
    net.COUNTERS.update(blocked=0, blocked_hosts={}, fetched=0, since=time.time())
    return {"offline": offline(), **d}


def clear_offline_tiles() -> None:
    p = PATHS["cache"] / "tiles_offline"
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)


# ------------------------------------------------------------------ manifest: url -> local file

_man = {"mtime": None, "data": None}


def manifest() -> dict:
    f = root() / "manifest.json"
    try:
        mt = f.stat().st_mtime
    except OSError:
        return {"files": {}, "packs": {}, "zones": []}
    if mt != _man["mtime"]:
        try:
            _man["data"] = json.loads(f.read_text())
            _man["mtime"] = mt
        except (OSError, ValueError):
            if _man["data"] is None:
                return {"files": {}, "packs": {}, "zones": []}
    d = _man["data"]
    d.setdefault("files", {})
    d.setdefault("packs", {})
    d.setdefault("zones", [])
    return d


def _save_manifest(m: dict) -> None:
    f = root() / "manifest.json"
    tmp = f.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(m))
    os.replace(tmp, f)
    _man["mtime"] = None


def _update_manifest(fn) -> None:
    with _lock:
        m = json.loads(json.dumps(manifest()))
        fn(m)
        _save_manifest(m)


def local_file(url: str) -> Path | None:
    """The complete local copy of a remote file, if Local mode has it."""
    e = manifest()["files"].get(url)
    if not e:
        return None
    p = root() / e["path"]
    try:
        return p if p.stat().st_size == e["bytes"] else None
    except OSError:
        return None


# ------------------------------------------------------------------ the 200 m HRSC + MOLA blend, read from the local file

class LocalRaster:
    """A single-band uncompressed GeoTIFF (striped or tiled-contiguous) read as a numpy memory map: random access to an
    11 GB elevation model in microseconds, with no GDAL. Falls back to None when the layout is not plain."""

    def __init__(self, path: Path):
        self.path = Path(path)
        t = _tiff_tags(self.path)
        W, H = int(t[256][0]), int(t[257][0])
        bits, comp = int(t[258][0]), int(t.get(259, [1])[0])
        spp = int(t.get(277, [1])[0])
        fmt = int(t.get(339, [2])[0])                      # 1 uint, 2 int, 3 float
        if comp != 1 or spp != 1 or 273 not in t:
            raise ValueError("not a plain uncompressed single-band TIFF")
        offs = np.asarray(t[273], np.int64)
        cnts = np.asarray(t[279], np.int64)
        item = bits // 8
        if len(offs) > 1 and not (np.all(np.diff(offs) == cnts[:-1])):
            raise ValueError("strips are not contiguous")
        if int(cnts.sum()) != W * H * item:
            raise ValueError("strip sizes do not add up")
        kind = {1: "u", 2: "i", 3: "f"}[fmt]
        self.dtype = np.dtype(f"{t['_bo']}{kind}{item}")
        self.W, self.H = W, H
        self.arr = np.memmap(self.path, dtype=self.dtype, mode="r", offset=int(offs[0]), shape=(H, W))
        sx, sy = float(t[33550][0]), float(t[33550][1])
        tp = t[33922]
        self.res_x, self.res_y = sx, sy
        self.lon0 = float(tp[3]) - float(tp[0]) * sx            # west edge of column 0 (pixel-is-area)
        self.lat0 = float(tp[4]) + float(tp[1]) * sy            # north edge of row 0
        nd = t.get(42113)
        self.nodata = float(nd.decode().strip("\x00 ")) if isinstance(nd, (bytes, bytearray)) and nd.strip(b"\x00 ") else -32768.0

    def sample(self, lon, lat) -> np.ndarray:
        lon = np.asarray(lon, np.float64)
        lat = np.asarray(lat, np.float64)
        col = ((lon - self.lon0) % 360.0) / self.res_x - 0.5
        row = (self.lat0 - lat) / self.res_y - 0.5
        row = np.clip(row, 0, self.H - 1.000001)
        r0 = np.floor(row).astype(np.int64)
        fr = row - r0
        r1 = np.minimum(r0 + 1, self.H - 1)
        c0f = np.floor(col)
        fc = col - c0f
        c0 = c0f.astype(np.int64) % self.W
        c1 = (c0 + 1) % self.W
        vals = [self.arr[r, c].astype(np.float32) for r, c in ((r0, c0), (r0, c1), (r1, c0), (r1, c1))]
        bad = np.zeros(lon.shape, bool)
        for v in vals:
            bad |= (v == self.nodata) | ~np.isfinite(v)
        a, b, c, d = vals
        out = (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr
        out[bad] = np.nan
        return out.astype(np.float32)


def _tiff_tags(path: Path) -> dict:
    """The first IFD of a TIFF / BigTIFF: {tag: values}. Enough for the layout and GeoTIFF georeferencing tags."""
    types = {1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 5: ("I", 8), 6: ("b", 1), 7: ("B", 1), 8: ("h", 2),
             9: ("i", 4), 10: ("i", 8), 11: ("f", 4), 12: ("d", 8), 16: ("Q", 8), 17: ("q", 8), 18: ("Q", 8)}
    with open(path, "rb") as f:
        hdr = f.read(16)
        bo = {b"II": "<", b"MM": ">"}[hdr[:2]]
        ver = struct.unpack(bo + "H", hdr[2:4])[0]
        big = ver == 43
        ifd = struct.unpack(bo + "Q", hdr[8:16])[0] if big else struct.unpack(bo + "I", hdr[4:8])[0]
        f.seek(ifd)
        n = struct.unpack(bo + ("Q" if big else "H"), f.read(8 if big else 2))[0]
        esz = 20 if big else 12
        raw = f.read(n * esz)
        tags: dict = {"_bo": bo}
        for i in range(n):
            e = raw[i * esz:(i + 1) * esz]
            tag, typ = struct.unpack(bo + "HH", e[:4])
            cnt = struct.unpack(bo + ("Q" if big else "I"), e[4:12] if big else e[4:8])[0]
            vraw = e[12:20] if big else e[8:12]
            fmt, size = types.get(typ, ("B", 1))
            total = size * cnt
            if total <= len(vraw):
                data = vraw[:total]
            else:
                off = struct.unpack(bo + ("Q" if big else "I"), vraw)[0]
                pos = f.tell()
                f.seek(off)
                data = f.read(total)
                f.seek(pos)
            if typ == 2:
                tags[tag] = data
            elif typ in (5, 10):
                v = np.frombuffer(data, dtype=np.dtype(bo + ("u4" if typ == 5 else "i4"))).astype(np.float64)
                tags[tag] = list(v[0::2] / np.where(v[1::2] == 0, 1, v[1::2]))
            else:
                dt = {"B": "u1", "b": "i1", "H": "u2", "h": "i2", "I": "u4", "i": "i4", "f": "f4", "d": "f8", "Q": "u8", "q": "i8"}[fmt]
                tags[tag] = np.frombuffer(data, dtype=np.dtype(bo + dt))
        return tags


_blend = {"obj": None, "key": None, "err": None}


def blend() -> LocalRaster | None:
    """The local 200 m blend as a memory map, once Local mode has downloaded it."""
    from .dem import BLEND_URL
    p = local_file(BLEND_URL)
    if p is None:
        return None
    key = (str(p), p.stat().st_mtime)
    if _blend["key"] != key:
        try:
            _blend.update(obj=LocalRaster(p), key=key, err=None)
        except Exception as e:  # noqa: BLE001 - unusual layout: the GDAL path (cog.read_lonlat on the local file) is used
            _blend.update(obj=None, key=key, err=f"{type(e).__name__}: {e}")
    return _blend["obj"]


# ------------------------------------------------------------------ geologic map units, local (point lookup offline)

GEO_ITEMS = "https://astrogeology.usgs.gov/pygeoapi/collections/mars/sim3292_global_geologic_map/units/items"
_geo = {"mtime": None, "feats": None}


def _geo_index():
    f = root() / "geology_units.json"
    try:
        mt = f.stat().st_mtime
    except OSError:
        return None
    if _geo["mtime"] != mt:
        d = json.loads(f.read_text())
        feats = []
        for ft in d.get("features", []):
            g = ft.get("geometry") or {}
            polys = g.get("coordinates") or []
            if g.get("type") == "Polygon":
                polys = [polys]
            elif g.get("type") != "MultiPolygon":
                continue
            rings = [[np.asarray(r, np.float64) for r in poly] for poly in polys if poly]
            if not rings:
                continue
            allp = np.concatenate([r[0] for r in rings])
            bb = (allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max())
            p = ft.get("properties") or {}
            feats.append((bb, rings, {"unit": p.get("unit"), "description": p.get("unitdesc")}))
        _geo.update(mtime=mt, feats=feats)
    return _geo["feats"]


def _inside(ring: np.ndarray, x: float, y: float) -> bool:
    xs, ys = ring[:, 0], ring[:, 1]
    x2, y2 = np.roll(xs, -1), np.roll(ys, -1)
    cond = (ys > y) != (y2 > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        xc = xs + (y - ys) * (x2 - xs) / (y2 - ys)
    return bool(np.count_nonzero(cond & (x < xc)) % 2)


def geology_local(lon: float, lat: float) -> dict | None:
    feats = _geo_index()
    if feats is None:
        return None
    for bb, rings, props in feats:
        if not (bb[0] <= lon <= bb[2] and bb[1] <= lat <= bb[3]):
            continue
        for poly in rings:
            if _inside(poly[0], lon, lat) and not any(_inside(h, lon, lat) for h in poly[1:]):
                return {**props, "cite": "Tanaka K.L. et al. 2014, Geologic map of Mars, USGS SIM 3292 (local copy)"}
    return {"unit": None, "description": "no unit (outside the mapped polygons)"}


# ------------------------------------------------------------------ the packs

def _imagery():
    from . import imagery
    return imagery


def _tile_avg(kind: str, default: int) -> int:
    """Average size of tiles of a kind already on disk (measured), else a typical value."""
    for base in (root() / "tiles" / kind, PATHS["tiles"] / kind):
        n = tot = 0
        if base.is_dir():
            for dp, _d, fs in os.walk(base):
                for f in fs:
                    if f.endswith((".tmp", ".part")):
                        continue
                    try:
                        tot += os.path.getsize(os.path.join(dp, f))
                        n += 1
                    except OSError:
                        pass
                    if n >= 400:
                        break
                if n >= 400:
                    break
        if n >= 20:
            return max(1000, tot // n)
    return default


def _global_tiles(maxz: int) -> int:
    return sum((2 << z) * (1 << z) for z in range(maxz + 1))


def _blend_url() -> str:
    from .dem import BLEND_URL
    return BLEND_URL


def global_packs() -> dict:
    """Whole-planet packs: id -> description with its native resolution and its measured or computed size."""
    from . import datasets, megdr
    im = _imagery()
    L = im.LAYERS
    ds = datasets.REGISTRY
    out = {
        "elevation": {"name": "MOLA elevation, whole planet", "res": "463 m (128 px/deg) and 3.7 km", "kind": "mola",
                      "bytes": megdr.G16["bytes"] + sum(t["bytes"] for t in megdr.T128),
                      "why": "The elevation base everywhere; 16 files from the PDS Geosciences Node.", "default": True},
        "blend": {"name": "HRSC + MOLA blended elevation, whole planet", "res": "200 m", "kind": "file",
                  "bytes": _sizes.get(_blend_url()) or 11_384_000_000, "why": "The best global elevation model (Fergason et al. 2018), one 11 GB file.", "default": True},
        "viking": {"name": "Viking colour mosaic, whole planet", "res": "232 m", "kind": "tiles", "tile_kind": "trek_viking",
                   "maxz": L["viking"]["maxz"], "avg": _tile_avg("trek_viking", 45000), "default": True,
                   "why": "The colour base map (MDIM 2.1, USGS / NASA Mars Trek)."},
        "mola_shade": {"name": "MOLA colour relief, whole planet", "res": "463 m", "kind": "tiles", "tile_kind": "trek_mola",
                       "maxz": L["mola"]["maxz"], "avg": _tile_avg("trek_mola", 40000), "default": True,
                       "why": "Colour-coded elevation with relief shading."},
        "geology": {"name": "Global geologic map (USGS SIM 3292)", "res": "1:20 000 000 map, tiles to 330 m", "kind": "geology",
                    "maxz": 7, "avg": _tile_avg("trek_geology", 12000), "default": True,
                    "why": "Map units for every point (polygons) and the coloured overlay (tiles)."},
        "science": {"name": "Science layers: water ice, thermal inertia, albedo, GRS chemistry, gravity, craters",
                    "res": "3 km / 7 km / 5 deg / degree 120 / every crater >= 1 km",
                    "kind": "science", "bytes": int(sum(r["size_mb"] for r in ds.values()) * 1e6), "default": True,
                    "why": "SWIM, TES, Mars Odyssey GRS (H2O, Fe, Cl, K, Th, Si), MRO GMM-3 gravity and the Robbins & Hynek crater database."},
        "atlas": {"name": "Mineral and surface maps (TES plagioclase, pyroxene, sheet silicates, dust cover; MOLA roughness)",
                  "res": "4-16 px/deg", "kind": "atlas", "tiles": 0, "avg": 120000, "default": True,
                  "why": "The published TES and MOLA colour maps from NASA Mars Trek. The mineral, ice, activity and mission feature "
                         "catalogues ship with MarsNav and need nothing."},
        "hrsc_shade": {"name": "HRSC + MOLA colour relief, whole planet", "res": "200 m", "kind": "tiles", "tile_kind": "trek_hrsc_shade",
                       "maxz": L["hrsc_shade"]["maxz"], "avg": _tile_avg("trek_hrsc_shade", 35000), "default": False,
                       "why": "Mars Express HRSC elevation blended with MOLA, as shaded colour relief. Large."},
        "reference": {"name": "Catalogues and names", "res": "every HiRISE / CTX DTM footprint, every IAU name", "kind": "reference",
                      "bytes": 60_000_000, "default": True,
                      "why": "Where high-resolution data exist (USGS STAC) and 2,000+ official place names."},
        "themis_day": {"name": "THEMIS day-time infrared, whole planet", "res": "100 m", "kind": "tiles", "tile_kind": "trek_themis_day",
                       "maxz": L["themis_day"]["maxz"], "avg": _tile_avg("trek_themis_day", 30000), "default": False,
                       "why": "Morphology at 100 m everywhere. Large: the zone packs already include it around each site."},
        "themis_night": {"name": "THEMIS night-time infrared, whole planet", "res": "100 m", "kind": "tiles", "tile_kind": "trek_themis_night",
                         "maxz": L["themis_night"]["maxz"], "avg": _tile_avg("trek_themis_night", 30000), "default": False,
                         "why": "Rock versus loose fines at 100 m everywhere. Large: included around each zone anyway."},
    }
    for k, p in out.items():
        if p["kind"] in ("tiles", "geology"):
            p["tiles"] = _global_tiles(p["maxz"])
            p["bytes"] = p["tiles"] * p["avg"] + (40_000_000 if p["kind"] == "geology" else 0)
    from . import atlas
    out["atlas"]["tiles"] = sum(_global_tiles(T["maxz"]) for T in atlas.TREK_OVL.values())
    out["atlas"]["bytes"] = out["atlas"]["tiles"] * out["atlas"]["avg"]
    return out


ZONE_PARTS = {
    "hirise_dtm": "HiRISE elevation models, 1 m (complete files)",
    "hirise_ortho": "HiRISE orthoimages, 25-50 cm (complete files)",
    "ctx_dtm": "CTX elevation models, 20 m (complete files)",
    "ctx_ortho": "CTX orthoimages, 6 m (complete files)",
    "ctx_mosaic": "CTX global mosaic, 5 m (every tile in the zone)",
    "themis": "THEMIS day and night infrared, 100 m",
    "prerender": "Map tiles pre-rendered from all of it (instant display)",
}


def zone_box(z: dict) -> tuple[float, float, float, float]:
    r = float(z.get("radius_km", 25)) * 1000
    dlat = math.degrees(r / R_MARS)
    dlon = math.degrees(r / (R_MARS * max(0.05, math.cos(math.radians(z["lat"])))))
    return z["lon"] - dlon, max(-89.9, z["lat"] - dlat), z["lon"] + dlon, min(89.9, z["lat"] + dlat)


def _box_tiles(box, zmin: int, zmax: int):
    from .tiling import ntiles, tile_deg
    w, s, e, n = box
    for z in range(zmin, zmax + 1):
        d = tile_deg(z)
        cols, rows = ntiles(z)
        x0, x1 = int(math.floor((w + 180) / d)), int(math.floor((e + 180 - 1e-9) / d))
        y0, y1 = max(0, int(math.floor((90 - n) / d))), min(rows - 1, int(math.floor((90 - s - 1e-9) / d)))
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                yield z, y, x % cols


def _zone_products(z: dict) -> dict:
    """The HiRISE and CTX products whose footprints touch a zone: {part: [(url, id), ...]}."""
    from . import catalog
    box = zone_box(z)
    out = {k: [] for k in ("hirise_dtm", "hirise_ortho", "ctx_dtm", "ctx_ortho")}
    for kind in ("hirise", "ctx"):
        for it in catalog.query(kind, *box, limit=100000):
            out[f"{kind}_dtm"].append((it["dtm"], it["id"]))
            if it.get("ortho"):
                out[f"{kind}_ortho"].append((it["ortho"], it["id"]))
    return out


def _prerender_zmax(z: dict) -> int:
    r = float(z.get("radius_km", 25))
    return 14 if r <= 10 else 13 if r <= 30 else 12 if r <= 80 else 11


_sizes: dict = {}


def _size_of(url: str) -> int | None:
    from . import net
    if url in _sizes:
        return _sizes[url]
    lf = local_file(url)
    if lf is not None:
        _sizes[url] = lf.stat().st_size
        return _sizes[url]
    try:
        n = net.head(url)
    except Exception:  # noqa: BLE001
        n = None
    if n:
        _sizes[url] = n
    return n


def estimate(plan: dict) -> dict:
    """Sizes of everything a plan would download, what is already here, and the free disk. plan = {"global": [ids],
    "zones": [{id, name, lon, lat, radius_km, parts: [...]}]}."""
    from . import catalog, net
    gp = global_packs()
    items = []
    from .dem import BLEND_URL
    if "blend" in plan.get("global", []):
        gp["blend"]["bytes"] = (_size_of(BLEND_URL) if not net.blocked() or local_file(BLEND_URL) else None) or 11_384_000_000
    st = status(light=True)
    for gid in plan.get("global", []):
        p = gp.get(gid)
        if not p:
            continue
        have = st["packs"].get(gid, {}).get("bytes", 0)
        items.append({"id": gid, "group": "global", "label": p["name"], "res": p["res"], "bytes": p["bytes"],
                      "have": min(have, p["bytes"]), "count": p.get("tiles"), "approx": p["kind"] in ("tiles", "geology")})
    for kind in ("hirise", "ctx"):
        if not catalog.ready(kind):
            catalog.load(kind, wait=True)
    urls = []
    zone_rows = []
    for z in plan.get("zones", []):
        prods = _zone_products(z)
        parts = z.get("parts") or list(ZONE_PARTS)
        box = zone_box(z)
        for part in parts:
            row = {"id": f"{z['id']}:{part}", "group": z["id"], "zone": z.get("name"), "label": ZONE_PARTS.get(part, part), "part": part}
            if part in prods:
                lst = prods[part]
                row["count"] = len(lst)
                row["urls"] = [u for u, _i in lst]
                urls += row["urls"]
            elif part == "ctx_mosaic":
                n = sum(1 for _ in _box_tiles(box, 0, _imagery().ESRI_SVC["ctx"]["maxz"]))
                row.update(count=n, bytes=n * _tile_avg("esri_ctx", 66000), approx=True)
            elif part == "themis":
                n = 2 * sum(1 for _ in _box_tiles(box, 0, 9))
                row.update(count=n, bytes=n * _tile_avg("trek_themis_day", 30000), approx=True)
            elif part == "prerender":
                n = sum(1 for _ in _box_tiles(box, 0, _prerender_zmax(z)))
                row.update(count=n, bytes=n * 120000, approx=True)
            zone_rows.append(row)
    if urls and not net.blocked():
        with ThreadPoolExecutor(16) as ex:
            list(ex.map(_size_of, sorted(set(urls))))
    for row in zone_rows:
        if "urls" in row:
            sizes = [_sizes.get(u) for u in row["urls"]]
            known = [s for s in sizes if s]
            row["bytes"] = int(sum(known) + (len(sizes) - len(known)) * (np.mean(known) if known else 300e6))
            row["have"] = int(sum(local_file(u).stat().st_size for u in row["urls"] if local_file(u) is not None))
            row["approx"] = len(known) < len(sizes)
            row.pop("urls")
        else:
            row["have"] = 0
        items.append(row)
    total = int(sum(i["bytes"] or 0 for i in items))
    have = int(sum(i.get("have") or 0 for i in items))
    du = shutil.disk_usage(root())
    return {"ok": True, "items": items, "total_bytes": total, "have_bytes": have, "need_bytes": max(0, total - have),
            "free_bytes": du.free, "fits": du.free - max(0, total - have) > 2e9}


# ------------------------------------------------------------------ install (a job process)

class _Cancelled(Exception):
    pass


class _Progress:
    """Writes progress.json (read by /api/local/status) at most twice a second."""

    def __init__(self, plan, total_bytes):
        self.d = {"running": True, "started": time.time(), "pid": os.getpid(), "plan": plan, "total_bytes": total_bytes,
                  "done_bytes": 0, "item": None, "item_done": 0, "item_total": 0, "items_done": 0, "items_total": 0,
                  "errors": [], "rate_bps": 0, "eta_s": None, "log": []}
        self.t = 0.0
        self.lk = threading.Lock()
        self.window = []

    def add_bytes(self, n):
        with self.lk:
            self.d["done_bytes"] += n
            self.d["item_done"] += n
        self.flush()

    def item(self, label, total):
        with self.lk:
            self.d.update(item=label, item_done=0, item_total=total)
        self.flush(force=True)

    def note(self, msg, log=None):
        with self.lk:
            self.d["log"] = (self.d["log"] + [f"{time.strftime('%H:%M:%S')} {msg}"])[-60:]
        if log:
            log(msg)
        self.flush(force=True)

    def error(self, msg):
        with self.lk:
            self.d["errors"] = (self.d["errors"] + [msg])[-40:]
        self.flush(force=True)

    def flush(self, force=False):
        now = time.time()
        if not force and now - self.t < 0.5:
            return
        self.t = now
        with self.lk:
            self.window = [w for w in self.window if now - w[0] < 20] + [(now, self.d["done_bytes"])]
            if len(self.window) > 1 and self.window[-1][0] > self.window[0][0]:
                rate = (self.window[-1][1] - self.window[0][1]) / (self.window[-1][0] - self.window[0][0])
                self.d["rate_bps"] = int(rate)
                left = max(0, self.d["total_bytes"] - self.d["done_bytes"])
                self.d["eta_s"] = int(left / rate) if rate > 1000 else None
            data = json.dumps(self.d)
        f = root() / "progress.json"
        tmp = f.with_suffix(f".{os.getpid()}.tmp")
        try:
            tmp.write_text(data)
            os.replace(tmp, f)
        except OSError:
            pass

    def finish(self, result):
        with self.lk:
            self.d.update(running=False, finished=time.time(), result=result)
        self.flush(force=True)


def _cancel_flag() -> Path:
    return root() / "cancel"


def _check_cancel():
    if _cancel_flag().exists():
        raise _Cancelled()


def request_cancel() -> dict:
    _cancel_flag().write_text(str(time.time()))
    return {"ok": True}


def _disk_guard(need: int):
    free = shutil.disk_usage(root()).free
    if free - need < 2e9:
        raise IOError(f"not enough disk space: {need / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free (2 GB is kept free)")


def _fetch_file(url: str, pack: str, prog: _Progress, log) -> int:
    """One complete remote file into files/..., resumable, SHA-256 recorded in the manifest. Returns bytes added."""
    from . import net
    if local_file(url) is not None:
        return 0
    dest = file_dest(url)
    size = _size_of(url)
    _disk_guard(size or 0)
    part = dest.with_suffix(dest.suffix + ".part")
    last = [part.stat().st_size if part.exists() else 0]
    prog.add_bytes(last[0])

    def pr(done, total):
        prog.add_bytes(done - last[0])
        last[0] = done

    class _H:                         # SHA-256 of the whole file, counting what it was fed
        def __init__(self):
            self.h, self.n = hashlib.sha256(), 0

        def update(self, b):
            self.h.update(b)
            self.n += len(b)
    h = _H()
    for attempt in range(4):
        try:
            net.download(url, dest, progress=pr, expected=size, timeout=90, resume=True, cancel=lambda: _cancel_flag().exists(),
                         hasher=h)
            break
        except InterruptedError:
            raise _Cancelled() from None
        except net.Offline:
            raise
        except Exception as e:  # noqa: BLE001 - network hiccup: resume from where it stopped
            if attempt == 3:
                raise
            prog.note(f"  retrying {url.rsplit('/', 1)[-1]} after {type(e).__name__}", log)
            time.sleep(5 + 10 * attempt)
            h = _H()
    digest = h.h.hexdigest() if h.n == dest.stat().st_size else None
    rel = str(dest.relative_to(root())).replace("\\", "/")
    n = dest.stat().st_size

    def upd(m):
        m["files"][url] = {"path": rel, "bytes": n, "sha256": digest, "pack": pack, "t": time.time()}
    _update_manifest(upd)
    return n


def _fetch_tiles(jobs: list, prog: _Progress, log, workers: int = 8) -> dict:
    """[(kind, z, y, x, url, ext)] -> tiles/..., skipping those already here; 404 = no data there (counted)."""
    from . import net
    got = {"new": 0, "have": 0, "missing": 0, "failed": 0, "bytes": 0}
    lk = threading.Lock()

    def one(j):
        kind, z, y, x, url, ext = j
        p = tile_path(kind, z, y, x, ext)
        if p.exists():
            with lk:
                got["have"] += 1
            return
        cached = PATHS["tiles"] / kind / str(z) / str(y) / f"{x}.{ext}"
        try:
            if cached.exists():
                data = cached.read_bytes()
            else:
                data = net.get(url, timeout=30, retries=2)
        except net.Offline:
            raise
        except Exception as e:  # noqa: BLE001
            code = getattr(e, "code", None)
            with lk:
                got["missing" if code in (400, 404, 410) else "failed"] += 1
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + f".{threading.get_ident()}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
        with lk:
            got["new"] += 1
            got["bytes"] += len(data)
        prog.add_bytes(len(data))
    done = 0
    with ThreadPoolExecutor(workers) as ex:
        for k in range(0, len(jobs), 400):
            _check_cancel()
            if k % 4000 == 0:
                _disk_guard(400 * 60000)
            list(ex.map(one, jobs[k:k + 400]))
            done = min(len(jobs), k + 400)
            with prog.lk:
                prog.d["tiles_done"], prog.d["tiles_total"] = done, len(jobs)
            prog.flush()
    return got


def _pack_done(pid: str, info: dict) -> None:
    def upd(m):
        m["packs"][pid] = {**m["packs"].get(pid, {}), **info, "t": time.time()}
    _update_manifest(upd)


def _trek_jobs(layer: str, kind: str, tiles) -> list:
    im = _imagery()
    L = im.LAYERS[layer]
    return [(kind, z, y, x, im.TREK.format(layer=L["layer"], z=z, y=y, x=x, ext=L["ext"]), L["ext"]) for z, y, x in tiles]


def _all_tiles(maxz: int):
    for z in range(maxz + 1):
        for y in range(1 << z):
            for x in range(2 << z):
                yield z, y, x


def _install_global(gid: str, prog: _Progress, log) -> dict:
    from . import catalog, datasets, megdr, names
    im = _imagery()
    gp = global_packs()[gid]
    prog.item(gp["name"], gp.get("bytes") or 0)
    if gid == "elevation":
        for info in [megdr.G16] + megdr.T128:
            _check_cancel()
            if megdr.have(info):
                continue
            _disk_guard(info["bytes"])
            prog.note(f"  MOLA {info['key']} ({info['bytes'] / 1e6:.0f} MB)", log)
            last = [0]

            def pr(done, total, last=last):
                prog.add_bytes(done - last[0])
                last[0] = done
            megdr.ensure(info, progress=pr)
        n = sum(megdr.have(t) for t in megdr.T128)
        return {"complete": n == len(megdr.T128) and megdr.have(megdr.G16), "files": n + megdr.have(megdr.G16),
                "bytes": sum(megdr.path_of(t).stat().st_size for t in [megdr.G16] + megdr.T128 if megdr.have(t))}
    if gid == "blend":
        from .dem import BLEND_URL
        n = _fetch_file(BLEND_URL, gid, prog, log)
        lf = local_file(BLEND_URL)
        lay = None
        if lf is not None:
            try:
                LocalRaster(lf)
                lay = "memory-mapped (fast)"
            except Exception as e:  # noqa: BLE001
                lay = f"read with GDAL ({e})"
        return {"complete": lf is not None, "files": 1, "bytes": lf.stat().st_size if lf else n, "layout": lay}
    if gid == "atlas":
        from . import atlas
        jobs = [(f"trek_{T['layer']}", z, y, x, atlas.TREK.format(layer=T["layer"], z=z, y=y, x=x), "png")
                for T in atlas.TREK_OVL.values() for z, y, x in _all_tiles(T["maxz"])]
        prog.note(f"  {len(jobs):,} map tiles of {len(atlas.TREK_OVL)} mineral and surface maps", log)
        r = _fetch_tiles(jobs, prog, log)
        return {"complete": r["failed"] == 0, "tiles": r["new"] + r["have"], "failed": r["failed"],
                "bytes": sum(_dir_bytes(root() / "tiles" / f"trek_{T['layer']}") for T in atlas.TREK_OVL.values())}
    if gid in ("viking", "mola_shade", "themis_day", "themis_night", "hrsc_shade"):
        layer = {"viking": "viking", "mola_shade": "mola"}.get(gid, gid)
        kind = f"trek_{layer}"
        jobs = _trek_jobs(layer, kind, _all_tiles(im.LAYERS[layer]["maxz"]))
        prog.note(f"  {len(jobs):,} tiles, zoom 0-{im.LAYERS[layer]['maxz']}", log)
        r = _fetch_tiles(jobs, prog, log)
        return {"complete": r["failed"] == 0, "tiles": r["new"] + r["have"], "missing": r["missing"], "failed": r["failed"],
                "bytes": _dir_bytes(root() / "tiles" / kind)}
    if gid == "geology":
        jobs = [("trek_geology", z, y, x, im.TREK_GEOLOGY.format(z=z, y=y, x=x), "png") for z, y, x in _all_tiles(7)]
        prog.note(f"  {len(jobs):,} map tiles, zoom 0-7", log)
        r = _fetch_tiles(jobs, prog, log)
        prog.note("  map unit polygons (for point lookups)", log)
        units = _download_geology_units(prog, log)
        return {"complete": r["failed"] == 0 and units > 0, "tiles": r["new"] + r["have"], "units": units,
                "bytes": _dir_bytes(root() / "tiles" / "trek_geology") + _file_bytes(root() / "geology_units.json")}
    if gid == "science":
        res = datasets.install(None, log=lambda m: prog.note("  " + m, log))
        st = datasets.status()
        return {"complete": all(v["installed"] for v in st.values()), "failed": res.get("failed", {}),
                "bytes": sum(_dir_bytes(datasets.ds_dir(k)) for k in st)}
    if gid == "reference":
        for kind in ("hirise", "ctx"):
            prog.note(f"  STAC {kind} footprint catalogue", log)
            catalog.load(kind, wait=True)
        names.load()
        return {"complete": catalog.ready("hirise") and catalog.ready("ctx"),
                "hirise": len(catalog.load("hirise")), "ctx": len(catalog.load("ctx")), "names": len(names.load()),
                "bytes": _dir_bytes(PATHS["catalog"])}
    raise ValueError(f"unknown pack {gid}")


def _download_geology_units(prog, log) -> int:
    from . import net
    out, offset = [], 0
    while True:
        _check_cancel()
        page = net.get_json(f"{GEO_ITEMS}?f=json&limit=500&offset={offset}", timeout=120, retries=3)
        feats = page.get("features", [])
        out += feats
        prog.add_bytes(sum(len(json.dumps(f)) for f in feats[:5]) * max(1, len(feats)) // 5 if feats else 0)
        if len(feats) < 500:
            break
        offset += 500
    if out:
        (root() / "geology_units.json").write_text(json.dumps({"type": "FeatureCollection", "features": out,
                                                               "source": GEO_ITEMS, "t": time.time()}))
    return len(out)


def _dir_bytes(p: Path) -> int:
    n = 0
    if p.is_dir():
        for dp, _d, fs in os.walk(p):
            for f in fs:
                try:
                    n += os.path.getsize(os.path.join(dp, f))
                except OSError:
                    pass
    return n


def _file_bytes(p: Path) -> int:
    try:
        return p.stat().st_size
    except OSError:
        return 0


def _install_zone(z: dict, prog: _Progress, log) -> dict:
    im = _imagery()
    box = zone_box(z)
    parts = z.get("parts") or list(ZONE_PARTS)
    prods = _zone_products(z)
    res = {"parts": {}}
    for part in parts:
        _check_cancel()
        label = f"{z.get('name', z['id'])}: {ZONE_PARTS.get(part, part)}"
        if part in prods:
            lst = prods[part]
            prog.item(label, sum(_size_of(u) or 0 for u, _i in lst))
            prog.note(f"{label}: {len(lst)} file(s)", log)
            ok = 0
            for k, (url, pid) in enumerate(lst):
                _check_cancel()
                try:
                    _fetch_file(url, f"zone:{z['id']}", prog, log)
                    ok += 1
                except (_Cancelled, IOError):
                    raise
                except Exception as e:  # noqa: BLE001
                    prog.error(f"{pid}: {type(e).__name__}: {e}")
                if k % 5 == 4:
                    prog.note(f"  {k + 1}/{len(lst)} files", log)
            res["parts"][part] = {"files": len(lst), "ok": ok}
        elif part == "ctx_mosaic":
            E = im.ESRI_SVC["ctx"]
            jobs = [("esri_ctx", tz, ty, tx, im.ESRI.format(svc=E["svc"], z=tz, y=ty, x=tx), "img") for tz, ty, tx in _box_tiles(box, 0, E["maxz"])]
            prog.item(label, len(jobs) * _tile_avg("esri_ctx", 66000))
            prog.note(f"{label}: {len(jobs):,} tiles", log)
            res["parts"][part] = _fetch_tiles(jobs, prog, log)
        elif part == "themis":
            tl = list(_box_tiles(box, 0, 9))
            jobs = _trek_jobs("themis_day", "trek_themis_day", tl) + _trek_jobs("themis_night", "trek_themis_night", tl)
            prog.item(label, len(jobs) * 30000)
            prog.note(f"{label}: {len(jobs):,} tiles", log)
            res["parts"][part] = _fetch_tiles(jobs, prog, log)
        elif part == "prerender":
            res["parts"][part] = _prerender(z, box, prog, log, label)
    return res


def _prerender(z: dict, box, prog: _Progress, log, label: str) -> dict:
    """Elevation and imagery tiles for the zone, built from the local files (and anything still online), stored in the
    never-trimmed local tile folder: the zone then opens instantly in Mars mode."""
    from . import dem, imagery
    plan = list(_box_tiles(box, 0, _prerender_zmax(z)))
    prog.item(label, len(plan) * 120000)
    prog.note(f"{label}: {len(plan):,} tiles to zoom {_prerender_zmax(z)}", log)
    made = 0
    for k, (tz, ty, tx) in enumerate(plan):
        if k % 50 == 0:
            _check_cancel()
            with prog.lk:
                prog.d["tiles_done"], prog.d["tiles_total"] = k, len(plan)
        try:
            pd = tile_path("dem", tz, ty, tx, "mmd")
            if not pd.exists():
                elev, meta = dem.build(tz, ty, tx)
                pd.parent.mkdir(parents=True, exist_ok=True)
                pd.write_bytes(dem.encode(elev, meta))
                prog.add_bytes(pd.stat().st_size)
            pi = tile_path("img3_best", tz, ty, tx, "jpg")
            if not pi.exists():
                data, _m = imagery.build(tz, ty, tx, "best", ())
                pi.parent.mkdir(parents=True, exist_ok=True)
                pi.write_bytes(data)
                prog.add_bytes(len(data))
            made += 1
        except Exception as e:  # noqa: BLE001
            prog.error(f"tile {tz}/{ty}/{tx}: {type(e).__name__}: {e}")
    return {"tiles": made, "of": len(plan)}


def install(plan: dict, log=print) -> dict:
    """Download everything in plan (see estimate) to this computer. Resumable: run it again and it continues."""
    try:
        _cancel_flag().unlink()
    except OSError:
        pass
    est = estimate(plan)
    prog = _Progress(plan, est["need_bytes"])
    if not est["fits"]:
        msg = (f"needs {est['need_bytes'] / 1e9:.1f} GB but only {est['free_bytes'] / 1e9:.1f} GB is free on this disk "
               "(2 GB is kept free): choose fewer packs or a smaller zone")
        prog.error(msg)
        prog.finish({"ok": False, "error": msg})
        raise IOError(msg)
    todo = [("global", g) for g in plan.get("global", [])] + [("zone", z) for z in plan.get("zones", [])]
    with prog.lk:
        prog.d["items_total"] = len(todo)
    results, failed = {}, {}
    cancelled = False
    for k, (kind, it) in enumerate(todo):
        name = it if kind == "global" else f"zone {it.get('name', it['id'])}"
        prog.note(f"[{k + 1}/{len(todo)}] {name}", log)
        try:
            if kind == "global":
                r = _install_global(it, prog, log)
                _pack_done(it, r)
            else:
                r = _install_zone(it, prog, log)
                _pack_done(f"zone:{it['id']}", {"zone": {kk: it[kk] for kk in ("id", "name", "lon", "lat", "radius_km") if kk in it},
                                                "parts": it.get("parts") or list(ZONE_PARTS), **r,
                                                "bytes": sum(e["bytes"] for e in manifest()["files"].values() if e.get("pack") == f"zone:{it['id']}")})
            results[name] = r
        except _Cancelled:
            cancelled = True
            prog.note("cancelled: what is downloaded is kept, and Download continues from here", log)
            break
        except Exception as e:  # noqa: BLE001 - one pack failing must not stop the others
            failed[name] = f"{type(e).__name__}: {e}"
            prog.error(f"{name}: {type(e).__name__}: {e}")
            prog.note(f"  {name} did not finish: {type(e).__name__}: {e}", log)
            if isinstance(e, IOError) and "disk space" in str(e):
                break
        with prog.lk:
            prog.d["items_done"] = k + 1
    clear_offline_tiles()
    out = {"ok": not failed and not cancelled, "cancelled": cancelled, "failed": failed, "results": results,
           "local_bytes": status(light=True)["bytes"]}
    prog.finish(out)
    return out


# ------------------------------------------------------------------ status

def status(light: bool = False) -> dict:
    m = manifest()
    packs = dict(m["packs"])
    from . import datasets, megdr
    n128 = sum(megdr.have(t) for t in megdr.T128)
    packs.setdefault("elevation", {})
    packs["elevation"] = {**packs["elevation"], "complete": n128 == len(megdr.T128) and megdr.have(megdr.G16),
                          "bytes": sum(megdr.path_of(t).stat().st_size for t in [megdr.G16] + megdr.T128 if megdr.have(t)),
                          "files": n128 + int(megdr.have(megdr.G16))}
    st = datasets.status()
    packs["science"] = {**packs.get("science", {}), "complete": all(v["installed"] for v in st.values()),
                        "installed": [k for k, v in st.items() if v["installed"]]}
    from .dem import BLEND_URL
    lf = local_file(BLEND_URL)
    packs["blend"] = {**packs.get("blend", {}), "complete": lf is not None}
    if lf is not None:
        packs["blend"]["bytes"] = lf.stat().st_size
    file_bytes = sum(e["bytes"] for e in m["files"].values())
    out = {"ok": True, "offline": offline(), "since": _mode.get("since"), "packs": packs,
           "zones": [p["zone"] for k, p in m["packs"].items() if k.startswith("zone:") and "zone" in p],
           "files": len(m["files"]), "file_bytes": file_bytes}
    if light:
        out["bytes"] = file_bytes + packs["elevation"]["bytes"]
        return out
    now = time.time()
    if now - _bytes_cache["t"] > (20 if (root() / "progress.json").exists() and _running_hint() else 120):
        _bytes_cache.update(t=now, tiles=_dir_bytes(root() / "tiles"), ds=sum(_dir_bytes(datasets.ds_dir(k)) for k in st))
    out["tiles_bytes"] = _bytes_cache["tiles"]
    out["bytes"] = file_bytes + _bytes_cache["tiles"] + packs["elevation"]["bytes"] + _bytes_cache["ds"]
    du = shutil.disk_usage(root())
    out["disk"] = {"free": du.free, "total": du.total, "path": str(root())}
    try:
        pr = json.loads((root() / "progress.json").read_text())
        if pr.get("running") and pr.get("pid") and not _pid_alive(pr["pid"]):
            pr["running"] = False
            pr["stopped"] = "the download process ended unexpectedly; press Download to continue"
        out["progress"] = pr
    except (OSError, ValueError):
        out["progress"] = None
    from . import net
    out["net"] = {"online": None if offline() else net.status().get("online"), "counters": net.status()["counters"]}
    out["global_packs"] = {k: {kk: v.get(kk) for kk in ("name", "res", "bytes", "tiles", "why", "default", "kind")}
                           for k, v in global_packs().items()}
    out["zone_parts"] = ZONE_PARTS
    out["blend_layout"] = ("memory-mapped" if blend() is not None else _blend.get("err")) if lf is not None else None
    return out


_bytes_cache = {"t": 0.0, "tiles": 0, "ds": 0}


def _running_hint() -> bool:
    try:
        return bool(json.loads((root() / "progress.json").read_text()).get("running"))
    except (OSError, ValueError):
        return False


def _pid_alive(pid: int) -> bool:
    try:
        if os.name == "nt":
            import ctypes
            h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))      # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            code = ctypes.c_ulong()
            ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(h)
            return code.value == 259                                             # STILL_ACTIVE
        os.kill(int(pid), 0)
        return True
    except Exception:  # noqa: BLE001
        return False
