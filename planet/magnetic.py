"""Mars's crustal magnetic field (Mars Global Surveyor MAG/ER, Connerney et al. 2001): the field of magnetised ancient
crust measured from orbit at 400 +/- 30 km, as night-side medians in 1 x 1 deg bins (app/data/global/magnetic_mgs.*,
tools/build_magnetic.py). Mars has no global field today; these crustal fields are strongest in the southern highlands
(Terra Sirenum, Terra Cimmeria) and nearly absent over the large impact basins and the northern plains.

For crews [ASSUME, qualitative]: strong crustal fields form local "mini-magnetospheres" that can turn away part of the
solar wind and low-energy charged particles; they do little against galactic cosmic rays, so they are context, not
shielding a mission can count on. The radial component Br is mapped; |B| is given at a point."""
from __future__ import annotations

import gzip
import json
import threading

import numpy as np

from . import config

_lock = threading.Lock()
_c: dict = {}
STOPS = [(-120, (40, 80, 230, 0.70)), (-40, (70, 140, 240, 0.55)), (-8, (120, 180, 240, 0.0)), (8, (240, 170, 120, 0.0)),
         (40, (240, 110, 60, 0.55)), (120, (220, 30, 30, 0.72))]


def available() -> bool:
    d = config.PATHS["app_data"] / "global"
    return (d / "magnetic_mgs.json").exists() and (d / "magnetic_mgs.bin.gz").exists()


def load() -> dict:
    with _lock:
        if not _c:
            d = config.PATHS["app_data"] / "global"
            m = json.loads((d / "magnetic_mgs.json").read_text())
            a = np.frombuffer(gzip.decompress((d / m["file"]).read_bytes()), "<i2").reshape(m["shape"]).astype(np.float32) * m["scale_nT"]
            _c.update(m=m, a=a)
        return _c


def sample(lon, lat, comp: str = "br"):
    """Bilinear value (nT) at points; periodic in longitude, clamped at the poles."""
    c = load()
    a = c["a"][c["m"]["planes"].index(comp)]
    g = c["m"]["grid"]
    lon = np.asarray(lon, np.float64)
    lat = np.asarray(lat, np.float64)
    fi = np.clip((g["lat0"] - lat) / g["step_deg"], 0, 179)
    i0 = np.minimum(178, np.floor(fi)).astype(int)
    di = fi - i0
    fj = np.mod((lon - g["lon0"]) / g["step_deg"], 360)
    j0 = np.floor(fj).astype(int) % 360
    j1 = (j0 + 1) % 360
    dj = fj - np.floor(fj)
    return (a[i0, j0] * (1 - dj) + a[i0, j1] * dj) * (1 - di) + (a[i0 + 1, j0] * (1 - dj) + a[i0 + 1, j1] * dj) * di


def point(lon: float, lat: float) -> dict | None:
    if not available():
        return None
    br, bt, bp = (float(sample(np.array([lon]), np.array([lat]), k)[0]) for k in ("br", "bt", "bp"))
    b = (br * br + bt * bt + bp * bp) ** 0.5
    word = "strong" if b >= 100 else "moderate" if b >= 30 else "weak" if b >= 10 else "negligible"
    return {"br_nT": round(br, 1), "btotal_nT": round(b, 1), "word": word, "altitude_km": 400,
            "cite": "MGS MAG/ER, Connerney et al. 2001 (GRL 28, 4015)"}


def legend() -> dict:
    from .datasets import _ramp
    ticks = [-100, -40, 0, 40, 100]
    return {"title": "Crustal magnetic field Br at 400 km (MGS, nT)",
            "note": "Radial field of magnetised ancient crust measured by Mars Global Surveyor at 400 km (Connerney et al. 2001, GRL 28, "
                    "4015). Red outward, blue inward; strongest in Terra Sirenum and Terra Cimmeria, absent over Hellas, Argyre and the "
                    "northern plains. Local mini-magnetospheres deflect some solar wind; they do not shield galactic cosmic rays.",
            "ticks": [{"v": t, "label": f"{t:+d}" if t else "0", "rgba": [float(c) for c in _ramp(np.array([t], np.float32), STOPS)[0]]} for t in ticks]}


def overlay_rgba(z: int, y: int, x: int, size: int = 256):
    if not available():
        return None
    from PIL import Image

    from .datasets import _ramp
    from .tiling import bounds
    w, s, e, n = bounds(z, y, x)
    k = 48
    lons = w + (np.arange(k) + 0.5) * (e - w) / k
    lats = n - (np.arange(k) + 0.5) * (n - s) / k
    LO, LA = np.meshgrid(lons, lats)
    rgba = _ramp(sample(LO, LA, "br").astype(np.float32), STOPS)
    chans = [np.asarray(Image.fromarray((rgba[..., c] * 255).astype(np.uint8)).resize((size, size), Image.BILINEAR), np.float32) / 255
             for c in range(4)]
    return np.stack(chans, axis=2)
