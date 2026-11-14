"""Seasonal dust climatology on the server: the same product and arithmetic as engine/dust.js.

app/data/global/dust_cdod.{json,bin.gz} (tools/build_dust.py): the Mars Climate Database dust scenarios MY 24-36
(Montabone et al. 2015, 2020; CC BY-SA 3.0), as the 10th / 50th / 90th percentile of the 9.3 um absorption column dust
optical depth at 610 Pa in each 10 deg Ls bin on a 3 deg grid, plus each year's bin means on a 6 deg grid.

Visible optical depth at a place = 2.6 x stored value x (local surface pressure / 610 Pa).
Overlay ids for the globe (planet/imagery.py): dust@<Ls> (median at that season) and dust90@<Ls> (90th percentile)."""
from __future__ import annotations

import gzip
import json
import re
import threading

import numpy as np

from . import config

STATS = ("p10", "p50", "p90")
OVL_RE = re.compile(r"^dust(90)?@(\d{1,3})$")
_lock = threading.Lock()
_cache: dict = {}


def _paths():
    d = config.PATHS["app_data"] / "global"
    return d / "dust_cdod.json", d / "dust_cdod.bin.gz"


def available() -> bool:
    j, b = _paths()
    return j.exists() and b.exists()


def load() -> dict:
    with _lock:
        if "m" in _cache:
            return _cache
        j, b = _paths()
        meta = json.loads(j.read_text())
        q = np.frombuffer(gzip.decompress(b.read_bytes()), np.uint8)
        tmax = meta["encoding"]["tau_max"]
        lut = np.where(np.arange(256) == 255, np.nan, tmax * (np.arange(256) / 254.0) ** 2)
        st = lut[q[:meta["years"]["offset"]]].reshape(meta["stats"]["shape"])
        yr = lut[q[meta["years"]["offset"]:]].reshape(meta["years"]["shape"])
        _cache.update(m=meta, stats=st, years=yr)
        return _cache


def _bins(ls):
    w = 360.0 / 36
    u = (np.mod(np.asarray(ls, np.float64), 360.0) - w / 2) / w
    k = np.floor(u)
    return np.mod(k, 36).astype(int), np.mod(k + 1, 36).astype(int), u - k


def _bil(field, lat0, lon0, step, lon, lat):
    """Bilinear on a north-to-south, periodic-in-longitude grid of points; field (nlat, nlon); lon/lat arrays."""
    nlat, nlon = field.shape
    fi = np.clip((lat0 - np.asarray(lat, np.float64)) / step, 0, nlat - 1)
    i0 = np.minimum(nlat - 2, np.floor(fi)).astype(int)
    di = np.minimum(1.0, fi - i0)
    fj = np.mod((np.asarray(lon, np.float64) - lon0) / step, nlon)
    j0 = np.floor(fj).astype(int) % nlon
    j1 = (j0 + 1) % nlon
    dj = fj - np.floor(fj)
    a = field[i0, j0] * (1 - dj) + field[i0, j1] * dj
    b = field[i0 + 1, j0] * (1 - dj) + field[i0 + 1, j1] * dj
    return a * (1 - di) + b * di


def cdod(lon, lat, ls, stat: str = "p50"):
    """Stored 9.3 um absorption CDOD at 610 Pa (vectorised over lon/lat; one season)."""
    c = load()
    g = c["m"]["grid"]
    s = STATS.index(stat)
    k0, k1, w = _bins(ls)
    a = _bil(c["stats"][s, int(k0)], g["lat"][0], g["lon"][0], g["step_deg"], lon, lat)
    b = _bil(c["stats"][s, int(k1)], g["lat"][0], g["lon"][0], g["step_deg"], lon, lat)
    return a * (1 - float(w)) + b * float(w)


def tau_visible(lon, lat, ls, stat: str = "p50", pressure_pa=610.0):
    m = load()["m"]["use"]
    return m["visible_factor"] * cdod(lon, lat, ls, stat) * np.asarray(pressure_pa, np.float64) / m["pressure_ref_pa"]


def year_cdod(lon, lat, ls, my: int):
    c = load()
    yl = c["m"]["years"]["list"]
    if my not in yl:
        return np.full(np.shape(lon), np.nan)
    G = c["m"]["years"]["grid"]
    k0, k1, w = _bins(ls)
    y = yl.index(my)
    a = _bil(c["years"][y, int(k0)], G["lat0"], G["lon0"], G["step_deg"], lon, lat)
    b = _bil(c["years"][y, int(k1)], G["lat0"], G["lon0"], G["step_deg"], lon, lat)
    return a * (1 - float(w)) + b * float(w)


def season(lon: float, lat: float, pressure_pa: float = 610.0, step: float = 5.0) -> dict:
    """The year at one place as visible optical depth at the given pressure: percentiles every `step` deg of Ls, each
    year's own curve every 10 deg, the clearest and dustiest seasons, and the global dust storm years."""
    c = load()
    m = c["m"]
    f = m["use"]["visible_factor"] * pressure_pa / m["use"]["pressure_ref_pa"]
    lss = np.arange(0, 360 + 1e-9, step)
    curve = [{"ls": float(L), **{s: round(float(f * cdod(np.array([lon]), np.array([lat]), L, s)[0]), 3) for s in STATS}} for L in lss]
    med = np.array([r["p50"] for r in curve])
    years = {}
    for my in m["years"]["list"]:
        v = [f * float(year_cdod(np.array([lon]), np.array([lat]), L, my)[0]) for L in np.arange(5, 360, 10)]
        years[str(my)] = [None if not np.isfinite(x) else round(x, 3) for x in v]
    k_lo, k_hi = int(np.argmin(med[:-1])), int(np.argmax(med[:-1]))
    p90 = np.array([r["p90"] for r in curve])
    return {"curve": curve, "years": years, "year_ls": list(range(5, 360, 10)),
            "clearest": {"ls": curve[k_lo]["ls"], "tau": curve[k_lo]["p50"]},
            "dustiest": {"ls": curve[k_hi]["ls"], "tau": curve[k_hi]["p50"]},
            "worst_p90": {"ls": curve[int(np.argmax(p90[:-1]))]["ls"], "tau": float(p90[:-1].max())},
            "storm_years": m["global_storm_years"], "storms": m["storms"], "pressure_pa": round(float(pressure_pa)),
            "cite": m["cite"], "licence": m["licence"], "url": m["url"]}


# ------------------------------------------------------------------ globe overlay
STOPS = [(0.2, (60, 60, 200, 0.0)), (0.35, (70, 130, 230, 0.35)), (0.6, (120, 200, 160, 0.45)), (1.0, (240, 210, 80, 0.5)),
         (2.0, (240, 120, 40, 0.58)), (4.0, (190, 40, 30, 0.66)), (8.0, (110, 20, 60, 0.72))]


def parse_ovl(ov: str):
    """'dust@250' -> ('p50', 250.0); 'dust90@250' -> ('p90', 250.0); anything else -> None."""
    m = OVL_RE.match(ov or "")
    if not m:
        return None
    return ("p90" if m.group(1) else "p50"), float(int(m.group(2)) % 360)


def legend(ov: str) -> dict | None:
    p = parse_ovl(ov)
    if not p:
        return None
    from .datasets import _ramp
    stat, ls = p
    ticks = [0.35, 0.6, 1.0, 2.0, 4.0]
    return {"title": f"Dust optical depth at Ls {ls:.0f}° ({'90th percentile, dusty years' if stat == 'p90' else 'median year'})",
            "note": "Visible column optical depth at the local surface pressure (MOLA elevation), from the Mars Climate Database dust "
                    "scenarios MY 24-36 (Montabone et al. 2015, 2020; CC BY-SA 3.0). Direct sunlight falls as e^-τ (to 37 % at τ 1 with "
                    "the Sun overhead; scattered light makes up part of it); above ~3 is a regional or global dust storm.",
            "ticks": [{"v": t, "label": f"{t:g}", "rgba": [float(c) for c in _ramp(np.array([t], np.float32), STOPS)[0]]} for t in ticks]}


def overlay_rgba(ov: str, z: int, y: int, x: int, size: int = 256):
    """(rgba, provisional). Visible optical depth at the local mean pressure from MOLA; until the MOLA grid is on this
    computer the 610 Pa datum is used and the tile is provisional (not cached, asked for again)."""
    p = parse_ovl(ov)
    if not p or not available():
        return None, True
    from PIL import Image

    from . import megdr
    from .datasets import _ramp
    from .tiling import bounds
    stat, ls = p
    w, s, e, n = bounds(z, y, x)
    k = 32                                                   # the field is 3 deg: compute coarse, then upsample
    lons = w + (np.arange(k) + 0.5) * (e - w) / k
    lats = n - (np.arange(k) + 0.5) * (n - s) / k
    LO, LA = np.meshgrid(lons, lats)
    try:
        el = megdr.sample16(LO.ravel(), LA.ravel(), wait=False)
    except Exception:  # noqa: BLE001
        el = None
    provisional = el is None
    pres = 610.0 if el is None else 610.0 * np.exp(-np.asarray(el, np.float64).reshape(LO.shape) / 11100.0)
    tau = tau_visible(LO, LA, ls, stat, pres)
    rgba = _ramp(np.asarray(tau, np.float32), STOPS)
    chans = [np.asarray(Image.fromarray((rgba[..., c] * 255).astype(np.uint8)).resize((size, size), Image.BILINEAR), np.float32) / 255
             for c in range(4)]
    return np.stack(chans, axis=2), provisional
