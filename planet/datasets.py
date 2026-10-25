"""Science and engineering data for choosing where astronauts land and live: per-place values and map overlays.

Installed once on request (Landing mode, "Install science layers", ~300 MB), converted to plain lon/lat grids and point
tables under data_cache/planet/base/ds/, then read here with numpy memory maps (no GDAL in the web server).

  swim     Subsurface Water Ice Mapping (SWIM4MIM, Planetary Science Institute for NASA): ice consistency Ci from -1
           (inconsistent with shallow ice) to +1 (consistent with every radar / neutron / thermal / geomorphic dataset),
           at 0-1 m, 1-5 m and >5 m depth; 60 S - 60 N, ~3 km.  Morgan et al. 2021, Nature Astronomy 5, 230;
           Morgan, Putzig et al. 2025, PSJ.  https://swim.psi.edu
  ti       TES night-time thermal inertia, 20 ppd (~3 km), J m^-2 K^-1 s^-1/2.  Putzig & Mellon 2007, Icarus 191, 68
           (PDS MGS-M-TES-5-TIMAP-V1.0).  Low values = loose fine dust (poor bearing strength, dust hazard to hardware).
  grs      Mars Odyssey Gamma Ray Spectrometer water-equivalent hydrogen as H2O weight %, 5 x 5 deg (upper ~0.5 m).
           Boynton et al. 2007, JGR 112; PDS ODY-M-GRS-5-ELEMENTS-V1.0.
  craters  Robbins & Hynek Mars crater database, 2020 release: 384,343 craters >= 1 km with diameter, depth and ejecta
           morphology.  Robbins & Hynek 2012, JGR 117, E05004.  https://craters.sjrdesign.net
Grids are stored as the value per 0.05 deg cell (TES, SWIM) or 5 deg cell (GRS), west to east from 180 W, north to south."""
from __future__ import annotations

import csv
import io
import json
import math
import threading
import time
import zipfile
from pathlib import Path

import numpy as np

from . import net
from .config import PATHS, R_MARS

SWIM_BASE = "https://swim.psi.edu/output/SWIM4MIM/Global/Composite/"
REGISTRY = {
    "swim": {
        "name": "SWIM subsurface water-ice consistency",
        "what": "Where shallow water ice is (in)consistent with all orbital evidence, at 0-1 m, 1-5 m and >5 m depth",
        "res": "~3 km, 60 S - 60 N", "size_mb": 213,
        "cite": "Morgan G.A. et al. 2021, Nature Astronomy 5, 230; Morgan, Putzig et al. 2025, PSJ 6 (SWIM4MIM). swim.psi.edu",
        "files": {"ci01": SWIM_BASE + "SWIM4MIM_Ci_0_1.tif", "ci15": SWIM_BASE + "SWIM4MIM_Ci_1_5.tif", "ci5": SWIM_BASE + "SWIM4MIM_Ci_5.tif"},
    },
    "ti": {
        "name": "TES thermal inertia (night)",
        "what": "How fast the ground heats and cools: low = fine loose dust, high = rock, bedrock or duricrust",
        "res": "20 px/deg (~3 km), global", "size_mb": 52,
        "cite": "Putzig N.E. & Mellon M.T. 2007, Icarus 191, 68 (PDS MGS-M-TES-5-TIMAP-V1.0)",
        "files": {"img": "https://pds-geosciences.wustl.edu/mgs/mgs-m-tes-5-timap-v1/mgst_9001/data/global_ti_night_2007.img"},
    },
    "grs": {
        "name": "Mars Odyssey GRS near-surface water",
        "what": "Water-equivalent hydrogen in the top ~0.5 m, as H2O weight %",
        "res": "5 x 5 deg, global", "size_mb": 0.2,
        "cite": "Boynton W.V. et al. 2007, JGR 112, E12S99 (PDS ODY-M-GRS-5-ELEMENTS-V1.0)",
        "files": {"tab": "https://pds-geosciences.wustl.edu/ody/ody-m-grs-5-elements-v1/odgm_xxxx/data/smoothed/h2o_sr_5x5.tab"},
    },
    "craters": {
        "name": "Robbins & Hynek crater database (2020)",
        "what": "384,343 craters of 1 km and larger: diameter, depth, ejecta type",
        "res": "every crater >= 1 km", "size_mb": 39,
        "cite": "Robbins S.J. & Hynek B.M. 2012, JGR 117, E05004 (2020 release, craters.sjrdesign.net)",
        "files": {"zip": "https://craters.sjrdesign.net/Catalog_Mars_Release_2020_1kmPlus_FullMorphData.csv.zip"},
    },
}
GRID_D = 0.05                     # deg per cell of the SWIM and TES grids
_lock = threading.Lock()
_mem: dict = {}


def ds_dir(did: str) -> Path:
    return PATHS["base"] / "ds" / did


def installed(did: str) -> bool:
    return (ds_dir(did) / "ok.json").exists()


def status() -> dict:
    out = {}
    for did, R in REGISTRY.items():
        info = {"name": R["name"], "what": R["what"], "res": R["res"], "size_mb": R["size_mb"], "cite": R["cite"], "installed": installed(did)}
        if info["installed"]:
            try:
                info.update(json.loads((ds_dir(did) / "ok.json").read_text()))
            except (OSError, ValueError):
                pass
        out[did] = info
    return out


# ------------------------------------------------------------------ install (runs in a job process: GDAL allowed there)

def install(ids=None, log=print) -> dict:
    """Download and convert the layers (a job process). Each layer is independent: one server being down (swim.psi.edu
    did not answer on 2026-09-28) leaves the others installed, and the result lists what failed and why."""
    ids = [i for i in (ids or list(REGISTRY)) if i in REGISTRY]
    done, failed = [], {}
    for did in ids:
        R = REGISTRY[did]
        if installed(did):
            log(f"{R['name']}: already installed")
            done.append(did)
            continue
        d = ds_dir(did)
        d.mkdir(parents=True, exist_ok=True)
        host = R["files"][next(iter(R["files"]))].split("/")[2]
        for attempt in (1, 2):
            t0 = time.time()
            try:
                log(f"{R['name']}: downloading {R['size_mb']} MB from {host}")
                {"swim": _install_swim, "ti": _install_ti, "grs": _install_grs, "craters": _install_craters}[did](d, log)
                (d / "ok.json").write_text(json.dumps({"installed_at": time.strftime("%Y-%m-%d %H:%M"), "seconds": round(time.time() - t0)}))
                log(f"{R['name']}: ready ({time.time() - t0:.0f} s)")
                done.append(did)
                break
            except Exception as e:  # noqa: BLE001 - network or format problem with this one layer
                why = _why(e, host)
                if attempt == 1 and _transient(e):
                    log(f"{R['name']}: {why}; trying again in 15 s")
                    time.sleep(15)
                    continue
                log(f"{R['name']}: NOT INSTALLED - {why}. The other layers are not affected; retry later from the Data tab.")
                failed[did] = why
                break
    return {"ok": not failed, "installed": done, "failed": failed}


def _transient(e: Exception) -> bool:
    import urllib.error
    if isinstance(e, urllib.error.HTTPError):
        return e.code >= 500 or e.code == 429
    return isinstance(e, (OSError, TimeoutError, urllib.error.URLError))


def _why(e: Exception, host: str) -> str:
    import urllib.error
    r = getattr(e, "reason", None)
    if isinstance(e, urllib.error.HTTPError):
        return f"{host} answered HTTP {e.code}"
    if isinstance(r, TimeoutError) or isinstance(e, TimeoutError) or "10060" in str(e) or "timed out" in str(e):
        return f"{host} did not answer (connection timed out; the server may be down)"
    if isinstance(e, urllib.error.URLError):
        return f"{host} could not be reached ({r})"
    return f"{type(e).__name__}: {e}"[:240]


def _progress(log, label):
    last = [0.0]

    def p(done, total):
        if time.time() - last[0] > 3:
            last[0] = time.time()
            log(f"  {label}: {done / 2**20:.0f} of {total / 2**20:.0f} MB" if total else f"  {label}: {done / 2**20:.0f} MB")
    return p


def _install_swim(d: Path, log):
    import rasterio
    nx, ny = int(360 / GRID_D), int(120 / GRID_D)                  # 180 W - 180 E, 60 N - 60 S
    dlon = -180.0 + (np.arange(nx) + 0.5) * GRID_D
    dlat = 60.0 - (np.arange(ny) + 0.5) * GRID_D
    for key, url in REGISTRY["swim"]["files"].items():
        raw = d / f"{key}.tif"
        net.download(url, raw, progress=_progress(log, key), timeout=120)
        log(f"  {key}: resampling to a 0.05 deg lon/lat grid")
        with rasterio.open(raw) as src:
            a = src.read(1).astype(np.float32)
            if src.nodata is not None:
                a[a == src.nodata] = np.nan
            a[(a < -1.5) | (a > 1.5)] = np.nan                       # SWIM no-data is -30
            T, H, W = src.transform, src.height, src.width
            # simple cylindrical: x = (lon - lon_0) * k_x, y = lat * k_y (metres, or degrees for a geographic CRS)
            if src.crs is None or src.crs.is_geographic:
                kx = ky = 1.0
                lon_0 = 0.0
            else:
                p = {}
                try:
                    p = src.crs.to_dict()
                except Exception:  # noqa: BLE001
                    pass
                Rm = float(p.get("R", p.get("a", 3396190.0)))
                lon_0 = float(p.get("lon_0", 0.0))
                lat_ts = float(p.get("lat_ts", 0.0))
                kx = Rm * math.cos(math.radians(lat_ts)) * math.pi / 180
                ky = Rm * math.pi / 180
        rows = np.floor((dlat * ky - T.f) / T.e).astype(np.int64)
        cols = np.full(nx, -1, np.int64)
        for shift in (0.0, 360.0, -360.0):                           # the product runs 0-360 E: take the copy that fits
            c = np.floor(((dlon + shift - lon_0) * kx - T.c) / T.a).astype(np.int64)
            fill = (cols < 0) & (c >= 0) & (c < W)
            cols[fill] = c[fill]
        okr, okc = (rows >= 0) & (rows < H), cols >= 0
        dst = np.full((ny, nx), np.nan, np.float32)
        rr, cc = np.where(okr)[0], np.where(okc)[0]
        dst[np.ix_(rr, cc)] = a[np.ix_(rows[rr], cols[cc])]
        q = np.where(np.isfinite(dst), np.clip(np.round(dst * 100), -100, 100), -128).astype(np.int8)
        np.save(d / f"{key}.npy", q)
        raw.unlink()
        log(f"  {key}: {np.isfinite(dst).mean() * 100:.0f} % of the 60 S - 60 N band has a value")
    (d / "meta.json").write_text(json.dumps({"lon0": -180.0, "lat0": 60.0, "d": GRID_D, "scale": 0.01, "nodata": -128}))


def _install_ti(d: Path, log):
    img = d / "ti.img"
    net.download(REGISTRY["ti"]["files"]["img"], img, progress=_progress(log, "thermal inertia"), expected=51840000, timeout=120)
    a = np.fromfile(img, dtype=">i2").reshape(3600, 7200).astype("<i2")
    a[a <= 0] = -1
    np.save(d / "ti.npy", a)
    img.unlink()
    (d / "meta.json").write_text(json.dumps({"lon0": -180.0, "lat0": 90.0, "d": 0.05, "scale": 1.0, "nodata": -1}))


def _install_grs(d: Path, log):
    txt = net.get(REGISTRY["grs"]["files"]["tab"], timeout=60).decode("ascii", "replace")
    g = np.full((36, 72), np.nan, np.float32)            # rows 90 N -> 90 S, cols 180 W -> 180 E
    for line in txt.splitlines():
        p = line.split()
        if len(p) < 3:
            continue
        try:
            lat, lon, v = float(p[0]), float(p[1]), float(p[2])
        except ValueError:
            continue
        if v > 9000:
            continue
        lon = lon - 360 if lon > 180 else lon
        r, c = int((90 - lat) // 5), int((lon + 180) // 5)
        if 0 <= r < 36 and 0 <= c < 72:
            g[r, c] = v
    np.save(d / "h2o.npy", g)
    (d / "meta.json").write_text(json.dumps({"lon0": -180.0, "lat0": 90.0, "d": 5.0, "scale": 1.0, "nodata": None}))
    log(f"  GRS: {np.isfinite(g).sum()} of 2,592 cells have a value")


def _install_craters(d: Path, log):
    z = d / "craters.zip"
    net.download(REGISTRY["craters"]["files"]["zip"], z, progress=_progress(log, "crater database"), timeout=180)
    log("  reading 384,343 craters")
    with zipfile.ZipFile(z) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith((".csv", ".tsv")))
        with zf.open(name) as fh:
            text = io.TextIOWrapper(fh, encoding="utf-8", errors="replace", newline="")
            first = text.readline().lstrip("\ufeff")
            delim = "\t" if first.count("\t") > first.count(",") else ","
            head = [h.strip().upper() for h in next(csv.reader([first], delimiter=delim))]
            col = {h: i for i, h in enumerate(head)}
            pick = lambda *names: next((col[n] for n in names if n in col), None)  # noqa: E731
            iid = pick("CRATER_ID")
            ila = pick("LAT_CIRC_IMG", "LATITUDE_CIRCLE_IMAGE", "LATITUDE")
            ilo = pick("LON_CIRC_IMG", "LONGITUDE_CIRCLE_IMAGE", "LONGITUDE")
            idm = pick("DIAM_CIRC_IMG", "DIAM_CIRCLE_IMAGE", "DIAMETER")
            idp = pick("DEPTH_RIMFLOOR_TOPOG", "DEPTH_RIMFLOOR")
            iej = pick("LAY_MORPH1", "MORPHOLOGY_EJECTA_1")
            iin = pick("INT_MORPH1", "MORPHOLOGY_INTERIOR_1")
            if None in (ila, ilo, idm):
                raise ValueError(f"unexpected crater table columns: {head[:12]}")
            ids, lat, lon, dia, dep, ej, inter = [], [], [], [], [], [], []
            for row in csv.reader(text, delimiter=delim):
                try:
                    la, lo, dm = float(row[ila]), float(row[ilo]), float(row[idm])
                except (ValueError, IndexError):
                    continue
                lo = lo - 360 if lo > 180 else lo
                lat.append(la); lon.append(lo); dia.append(dm)
                try:
                    dep.append(float(row[idp]) if idp is not None and row[idp].strip() else np.nan)
                except (ValueError, IndexError):
                    dep.append(np.nan)
                ids.append(row[iid] if iid is not None else "")
                ej.append(row[iej].strip()[:24] if iej is not None and len(row) > iej else "")
                inter.append(row[iin].strip()[:24] if iin is not None and len(row) > iin else "")
    if len(lat) < 100000:
        raise ValueError(f"only {len(lat)} craters read: the table format changed ({head[:8]})")
    order = np.argsort(np.array(lat, np.float32), kind="stable")
    lat_a = np.array(lat, np.float32)[order]
    np.savez(d / "craters.npz", lat=lat_a, lon=np.array(lon, np.float32)[order], d=np.array(dia, np.float32)[order],
             depth=np.array(dep, np.float32)[order], id=np.array(ids)[order], ejecta=np.array(ej)[order],
             interior=np.array(inter)[order])
    z.unlink()
    log(f"  {len(lat_a):,} craters indexed")


# ------------------------------------------------------------------ reading (server)

def _grid(did: str, fname: str):
    key = f"{did}/{fname}"
    with _lock:
        if key in _mem:
            return _mem[key]
    if not installed(did):
        return None
    d = ds_dir(did)
    arr = np.load(d / fname, mmap_mode="r")
    meta = json.loads((d / "meta.json").read_text())
    with _lock:
        _mem[key] = (arr, meta)
    return arr, meta


def _craters():
    with _lock:
        if "craters" in _mem:
            return _mem["craters"]
    if not installed("craters"):
        return None
    z = np.load(ds_dir("craters") / "craters.npz")
    c = {k: z[k] for k in z.files}
    with _lock:
        _mem["craters"] = c
    return c


def sample(grid, lon, lat):
    """Nearest-cell values of a lon/lat grid at arrays of points (NaN where no data)."""
    arr, m = grid
    lon = np.asarray(lon, np.float64)
    lat = np.asarray(lat, np.float64)
    r = np.floor((m["lat0"] - lat) / m["d"]).astype(np.int64)
    c = np.floor((((lon + 180.0) % 360.0) - 180.0 - m["lon0"]) / m["d"]).astype(np.int64) % arr.shape[1]
    ok = (r >= 0) & (r < arr.shape[0])
    out = np.full(lon.shape, np.nan, np.float32)
    if ok.any():
        v = np.asarray(arr[np.clip(r, 0, arr.shape[0] - 1), c], np.float32)
        if m.get("nodata") is not None:
            v = np.where(v == m["nodata"], np.nan, v)
        out = np.where(ok, v * m.get("scale", 1.0), np.nan).astype(np.float32)
    return out


def _one(did, fname, lon, lat):
    g = _grid(did, fname)
    if g is None:
        return None
    v = float(sample(g, np.array([lon]), np.array([lat]))[0])
    return None if not math.isfinite(v) else v


def ti_class(ti: float | None) -> str:
    if ti is None:
        return "unknown"
    if ti < 100:
        return "thick fine dust"
    if ti < 200:
        return "dust and sand"
    if ti < 350:
        return "sand, duricrust or mixed rock"
    return "rocky or bedrock"


def ice_near(lon: float, lat: float, radius_km: float = 100.0, threshold: float = 0.5) -> dict | None:
    """Nearest SWIM cell within radius_km whose ice consistency at 0-1 m or 1-5 m reaches threshold."""
    g1, g2 = _grid("swim", "ci01.npy"), _grid("swim", "ci15.npy")
    if g1 is None or g2 is None:
        return None
    (a1, m), (a2, _m2) = g1, g2
    if abs(lat) > 60:
        return {"found": False, "outside": True}
    d = m["d"]
    rr = int(math.ceil(radius_km / (d * math.pi / 180 * R_MARS / 1000))) + 1
    rc = int(math.ceil(rr / max(0.05, math.cos(math.radians(lat)))))
    r0 = int((m["lat0"] - lat) // d)
    c0 = int((lon + 180.0) // d)
    rows = np.arange(max(0, r0 - rr), min(a1.shape[0], r0 + rr + 1))
    cols = np.arange(c0 - rc, c0 + rc + 1) % a1.shape[1]
    if not rows.size:
        return {"found": False}
    b1 = np.asarray(a1[np.ix_(rows, cols)], np.float32)
    b2 = np.asarray(a2[np.ix_(rows, cols)], np.float32)
    v = np.maximum(np.where(b1 == -128, -200, b1), np.where(b2 == -128, -200, b2)) / 100.0
    lats = m["lat0"] - (rows + 0.5) * d
    lons = -180.0 + (np.arange(c0 - rc, c0 + rc + 1) + 0.5) * d
    LA, LO = np.meshgrid(lats, lons, indexing="ij")
    dist = _hav_km(lon, lat, LO, LA)
    good = (v >= threshold) & (dist <= radius_km)
    if not good.any():
        best = float(np.nanmax(np.where(dist <= radius_km, v, np.nan))) if np.isfinite(np.where(dist <= radius_km, v, np.nan)).any() else None
        return {"found": False, "best_ci": best}
    k = np.argmin(np.where(good, dist, np.inf))
    i, j = np.unravel_index(k, dist.shape)
    return {"found": True, "dist_km": round(float(dist[i, j]), 1), "lon": float(LO[i, j]), "lat": float(LA[i, j]),
            "ci": round(float(v[i, j]), 2), "depth": "0-1 m" if b1[i, j] / 100 >= threshold else "1-5 m",
            "share_within_km": round(float(good.sum() / max(1, (dist <= radius_km).sum())), 3)}


def _hav_km(lon0, lat0, lon, lat):
    p1, p2 = math.radians(lat0), np.radians(lat)
    dl = np.radians(lon - lon0)
    h = np.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R_MARS / 1000 * np.arcsin(np.minimum(1, np.sqrt(h)))


def craters_near(lon: float, lat: float, radius_km: float) -> dict | None:
    C = _craters()
    if C is None:
        return None
    dlat = radius_km / (R_MARS / 1000) * 180 / math.pi + 1.0          # + room for large craters' rims
    i0, i1 = np.searchsorted(C["lat"], [lat - dlat - 3, lat + dlat + 3])
    la, lo, dm = C["lat"][i0:i1], C["lon"][i0:i1], C["d"][i0:i1]
    dist = _hav_km(lon, lat, lo, la)
    rim = dist - dm / 2                                             # distance to the rim (negative: inside)
    near = rim <= radius_km
    inside = np.where((dist < dm / 2))[0]
    area = math.pi * radius_km ** 2
    cnt = int((dist <= radius_km).sum())
    big = int(((dist <= radius_km) & (dm >= 5)).sum())
    out = {"radius_km": radius_km, "count": cnt, "count_5km": big, "n1_per_1e6km2": round(cnt / area * 1e6, 0),
           "largest_km": round(float(dm[dist <= radius_km].max()), 1) if cnt else None}
    if inside.size:
        k = inside[np.argmin(dm[inside])]
        j = i0 + k
        out["inside"] = {"id": str(C["id"][j]), "diameter_km": round(float(dm[k]), 2),
                         "ejecta": str(C["ejecta"][j]) or None, "interior": str(C["interior"][j]) or None,
                         "depth_m": None if not math.isfinite(C["depth"][j]) else round(float(C["depth"][j]) * 1000, 0),
                         "centre_km": round(float(dist[k]), 2), "rim_km": round(float(-rim[k]), 2)}
    if near.any():
        cand = np.where(near & (dist >= dm / 2))[0]
        if cand.size:
            k = cand[np.argmin(rim[cand])]
            j = i0 + k
            out["nearest_rim"] = {"id": str(C["id"][j]), "diameter_km": round(float(dm[k]), 2),
                                  "rim_km": round(float(rim[k]), 2)}
    return out


def craters_in_box(w, s, e, n, min_px_km: float = 0.0, limit: int = 20000):
    C = _craters()
    if C is None:
        return None
    pad = 3.0
    i0, i1 = np.searchsorted(C["lat"], [s - pad, n + pad])
    la, lo, dm = C["lat"][i0:i1], C["lon"][i0:i1], C["d"][i0:i1]
    rdeg = dm / 2 / (R_MARS / 1000) * 180 / math.pi
    cl = np.maximum(0.05, np.cos(np.radians(la)))
    lo2 = np.where(lo < w - 180, lo + 360, np.where(lo > e + 180, lo - 360, lo))
    m = (la + rdeg >= s) & (la - rdeg <= n) & (lo2 + rdeg / cl >= w) & (lo2 - rdeg / cl <= e) & (dm >= min_px_km)
    idx = np.where(m)[0][:limit]
    return lo2[idx], la[idx], dm[idx], rdeg[idx], cl[idx]


def point(lon: float, lat: float) -> dict:
    """Every installed per-place value at one point."""
    out: dict = {"installed": {k: installed(k) for k in REGISTRY}}
    ci = {k: _one("swim", f"{k}.npy", lon, lat) for k in ("ci01", "ci15", "ci5")}
    out["ice"] = None if not installed("swim") else {"0-1 m": ci["ci01"], "1-5 m": ci["ci15"], ">5 m": ci["ci5"],
                                                      "covered": abs(lat) <= 60}
    ti = _one("ti", "ti.npy", lon, lat)
    out["ti"] = None if not installed("ti") else {"value": ti, "class": ti_class(ti)}
    h2o = _one("grs", "h2o.npy", lon, lat)
    out["grs_h2o_wt"] = None if not installed("grs") else h2o
    return out


# ------------------------------------------------------------------ geologic map unit (USGS OGC API, cached)

_geo_cache: dict = {}


def geology_at(lon: float, lat: float) -> dict | None:
    """Unit of the global geologic map (Tanaka et al. 2014, USGS SIM 3292) at a point, from the USGS OGC API."""
    key = (round(lon, 2), round(lat, 2))
    if key in _geo_cache:
        return _geo_cache[key]
    from . import localmode
    if net.blocked() or (localmode.root() / "geology_units.json").exists():
        try:
            res = localmode.geology_local(lon, lat)       # the map's polygons on this computer (Local mode)
        except Exception as e:  # noqa: BLE001
            res = {"error": f"{type(e).__name__}"}
        if res is not None:
            _geo_cache[key] = res
            return res
        return {"error": "Offline", "description": "geologic map not in the local packs"}
    eps = 0.0005
    url = ("https://astrogeology.usgs.gov/pygeoapi/collections/mars/sim3292_global_geologic_map/units/items?"
           f"bbox={lon - eps:.5f},{lat - eps:.5f},{lon + eps:.5f},{lat + eps:.5f}&f=json&skipGeometry=true&limit=3")
    try:
        j = net.get_json(url, timeout=12, retries=0)
        feats = j.get("features", [])
        if not feats:
            res = None
        else:
            p = feats[0].get("properties", {})
            res = {"unit": p.get("unit"), "description": p.get("unitdesc"),
                   "cite": "Tanaka K.L. et al. 2014, Geologic map of Mars, USGS SIM 3292"}
    except Exception as e:  # noqa: BLE001 - offline: no unit
        res = {"error": f"{type(e).__name__}"}
    _geo_cache[key] = res
    return res


# ------------------------------------------------------------------ overlays for imagery tiles

def _ramp(v, stops):
    """Colour ramp: stops = [(value, (r, g, b, a)), ...] ascending; v array -> (..., 4) float 0-1."""
    xs = np.array([s[0] for s in stops], np.float32)
    cols = np.array([s[1] for s in stops], np.float32) / np.array([255, 255, 255, 1], np.float32)
    out = np.zeros(v.shape + (4,), np.float32)
    ok = np.isfinite(v)
    vv = np.clip(np.where(ok, v, xs[0]), xs[0], xs[-1])
    for ch in range(4):
        out[..., ch] = np.interp(vv, xs, cols[:, ch])
    out[~ok, 3] = 0
    return out


ICE_STOPS = [(-1.0, (120, 80, 50, 0.0)), (0.0, (160, 200, 230, 0.0)), (0.25, (150, 210, 245, 0.30)), (0.5, (60, 170, 240, 0.55)),
             (1.0, (20, 70, 220, 0.75))]
TI_STOPS = [(30, (230, 80, 40, 0.60)), (100, (240, 150, 60, 0.50)), (200, (230, 220, 120, 0.40)), (350, (90, 200, 170, 0.45)),
            (600, (60, 110, 230, 0.55)), (1200, (120, 60, 200, 0.60))]
H2O_STOPS = [(2, (230, 200, 120, 0.0)), (4, (120, 200, 230, 0.30)), (8, (40, 140, 240, 0.50)), (20, (20, 60, 200, 0.65)),
             (40, (10, 20, 150, 0.75))]
LEGENDS = {
    "ice01": {"title": "Water ice 0-1 m (SWIM Ci)", "stops": ICE_STOPS, "fmt": "{:+.2f}", "ticks": [0.0, 0.25, 0.5, 1.0],
              "note": "Ci +1: every dataset consistent with shallow ice; 0: ambiguous; below 0 (clear): inconsistent. Mapped 60 S - 60 N."},
    "ice15": {"title": "Water ice 1-5 m (SWIM Ci)", "stops": ICE_STOPS, "fmt": "{:+.2f}", "ticks": [0.0, 0.25, 0.5, 1.0],
              "note": "Depth that excavation or a drill can reach for water production."},
    "ice5": {"title": "Water ice >5 m (SWIM Ci)", "stops": ICE_STOPS, "fmt": "{:+.2f}", "ticks": [0.0, 0.25, 0.5, 1.0], "note": ""},
    "ti": {"title": "Thermal inertia (TES, SI)", "stops": TI_STOPS, "fmt": "{:.0f}", "ticks": [30, 100, 200, 350, 600, 1200],
           "note": "Below 100: thick fine dust (weak ground, dust on hardware). NASA/SpaceX site studies exclude it."},
    "grs": {"title": "Near-surface water (GRS, H2O wt %)", "stops": H2O_STOPS, "fmt": "{:.0f} %", "ticks": [2, 4, 8, 20, 40],
            "note": "Top ~0.5 m; 5 deg cells. Above ~10 % at mid latitudes points to ground ice."},
    "craters": {"title": "Craters >= 1 km (Robbins & Hynek)", "stops": [], "note": "Rims of every catalogued crater of 1 km and larger."},
    "geology": {"title": "Geologic map (Tanaka et al. 2014)", "stops": [], "note": "USGS SIM 3292 units (colours as published)."},
}


def legend(ovl: str) -> dict | None:
    L = LEGENDS.get(ovl)
    if not L:
        return None
    out = {"title": L["title"], "note": L["note"]}
    if L.get("stops"):
        out["ticks"] = [{"v": t, "label": L["fmt"].format(t), "rgba": [float(c) for c in _ramp(np.array([t], np.float32), L["stops"])[0]]}
                        for t in L["ticks"]]
    return out


def overlay_rgba(ovl: str, z: int, y: int, x: int, size: int = 256):
    """(size, size, 4) float RGBA for an overlay on imagery tile (z, y, x), or None if its data is not installed."""
    from .tiling import bounds
    w, s, e, n = bounds(z, y, x)
    dd = (e - w) / size
    lons = w + (np.arange(size) + 0.5) * dd
    lats = n - (np.arange(size) + 0.5) * dd
    LO, LA = np.meshgrid(lons, lats)
    if ovl in ("ice01", "ice15", "ice5"):
        g = _grid("swim", {"ice01": "ci01.npy", "ice15": "ci15.npy", "ice5": "ci5.npy"}[ovl])
        return None if g is None else _ramp(sample(g, LO, LA), ICE_STOPS)
    if ovl == "ti":
        g = _grid("ti", "ti.npy")
        return None if g is None else _ramp(sample(g, LO, LA), TI_STOPS)
    if ovl == "grs":
        g = _grid("grs", "h2o.npy")
        return None if g is None else _ramp(sample(g, LO, LA), H2O_STOPS)
    if ovl == "craters":
        return _craters_rgba(w, s, e, n, size)
    return None


def _craters_rgba(w, s, e, n, size):
    from PIL import Image, ImageDraw
    got = craters_in_box(w, s, e, n, min_px_km=0.0)
    if got is None:
        return None
    lo, la, dm, rdeg, cl = got
    px_per_deg = size / (e - w)
    rpx = rdeg * px_per_deg
    keep = rpx >= 2.5                                    # draw a rim once it is at least ~5 px across
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    for x0, y0, r, c, d in zip((lo[keep] - w) * px_per_deg, (n - la[keep]) * px_per_deg, rpx[keep], cl[keep], dm[keep]):
        rx = r / c
        col = (255, 198, 41, 230) if d >= 5 else (255, 224, 140, 200)
        dr.ellipse([x0 - rx, y0 - r, x0 + rx, y0 + r], outline=col, width=2 if d >= 5 else 1)
    return np.asarray(im, np.float32) / np.array([255, 255, 255, 255], np.float32)
