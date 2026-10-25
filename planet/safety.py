"""Where can this lander touch down? A safe / caution / hazard / no-go map of any patch of Mars, at whatever resolution the
data there support, following how NASA screens landing sites:

  no-go    outside the lander's engineering envelope: elevation too high for the atmosphere to slow it (MSL/M2020:
           <= +1 km MOLA; human-class studies: <= +2 km), or latitude outside its limits (thermal/solar, EDL geometry)
  hazard   slope over the lander's limit (MSL/M2020 15 deg over 2-5 m), or relief steps too big for radar altimetry
           (MSL: 43 m over 200-1000 m)
  caution  steeper than 2/3 of the limit, or rough
  safe     inside every limit.  "Verified" only where a 1-2 m DTM (HiRISE) resolves the lander-scale 2-5 m slopes;
           elsewhere it is a candidate: rocks and scarps smaller than the data are not seen.

Slopes measured over a longer baseline are gentler than lander-scale slopes, so the thresholds tighten as the data get
coarser (the rule of thumb used in MSL/M2020 site screening: CTX/HRSC slopes are a first cut, HiRISE decides).
Sources: MSL Landing Site Selection User's Guide to Engineering Constraints v4.5.1 (JPL D-63687); Golombek et al. 2012,
Space Sci Rev 170 (MSL site selection); Grant et al. 2018 (Mars 2020 site selection); NASA Human Landing Sites Study
(HLS2, 2015)."""
from __future__ import annotations

import math

import numpy as np

from .config import R_MARS

LIMITS = {
    #          lander-scale slope   max MOLA elevation   |latitude|
    "viking": {"slope": 19.0, "elev": 1000.0, "lat": 50.0},
    "mer":    {"slope": 15.0, "elev": -1300.0, "lat": 15.0},
    "msl":    {"slope": 15.0, "elev": 1000.0, "lat": 30.0},
    "m2020":  {"slope": 15.0, "elev": 1000.0, "lat": 30.0},
    "human":  {"slope": 15.0, "elev": 2000.0, "lat": 50.0},
}
SAFE, CAUTION, HAZARD, NOGO = 0, 1, 2, 3
LEGEND = [
    {"cls": SAFE, "label": "Safe to land (verified at 1-2 m)", "rgba": [62, 224, 126, 0.42]},
    {"cls": SAFE, "label": "Candidate: safe at this resolution", "rgba": [62, 224, 126, 0.22]},
    {"cls": CAUTION, "label": "Caution: near the slope limit or rough", "rgba": [255, 198, 41, 0.42]},
    {"cls": HAZARD, "label": "Hazard: too steep / relief too high", "rgba": [255, 84, 72, 0.55]},
    {"cls": NOGO, "label": "No-go for this lander (elevation / latitude)", "rgba": [150, 100, 220, 0.45]},
]


def slope_limit_at(baseline_m: float, lander_limit: float) -> tuple[float, float]:
    """(hazard, caution) slope thresholds for slopes measured over baseline_m."""
    if baseline_m <= 5:
        f = 1.0
    elif baseline_m <= 30:
        f = 0.8
    elif baseline_m <= 250:
        f = 0.6
    else:
        f = 0.45
    hz = lander_limit * f
    return hz, hz * 2 / 3


def classify(Z: np.ndarray, lats: np.ndarray, cell_ns_m: float, finest_m: float, lander: str = "human") -> tuple[np.ndarray, dict]:
    """Classes for an elevation grid (rows north to south, lats per row). Returns (cls uint8, info)."""
    L = LIMITS.get(lander, LIMITS["human"])
    Zf = np.where(np.isfinite(Z), Z, np.nanmean(Z) if np.isfinite(Z).any() else 0.0).astype(np.float64)
    dy = cell_ns_m
    dx = dy * np.maximum(0.02, np.cos(np.radians(lats)))[:, None]
    gy, gx = np.gradient(Zf, dy, axis=0), np.gradient(Zf, axis=1) / dx
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    baseline = max(cell_ns_m, finest_m)
    hz, ca = slope_limit_at(baseline, L["slope"])
    cls = np.full(Z.shape, SAFE, np.uint8)
    cls[slope > ca] = CAUTION
    cls[slope > hz] = HAZARD
    # relief steps a radar altimeter cannot handle (MSL: 43 m over 200-1000 m baselines)
    if 150 <= baseline <= 1200:
        from scipy import ndimage as ndi
        k = max(1, int(round(500 / baseline)))
        rel = ndi.maximum_filter(Zf, size=2 * k + 1) - ndi.minimum_filter(Zf, size=2 * k + 1)
        cls[(rel > 43) & (cls < HAZARD)] = CAUTION
        cls[rel > 120] = HAZARD
    nogo = (Zf > L["elev"]) | (np.abs(lats)[:, None] > L["lat"])
    cls[nogo] = NOGO
    n = cls.size
    info = {"lander": lander, "baseline_m": round(baseline, 1), "verified": baseline <= 5, "slope_hazard_deg": round(hz, 1),
            "slope_caution_deg": round(ca, 1), "limits": L,
            "fractions": {k: round(float((cls == v).sum()) / n, 4) for k, v in (("safe", SAFE), ("caution", CAUTION), ("hazard", HAZARD), ("nogo", NOGO))}}
    return cls, info


def tile_classes(a: np.ndarray, meta: dict, lander: str) -> tuple[np.ndarray, dict]:
    """Classes of one 257 x 257 elevation tile, as 256 x 256 pixels (each pixel = the worst of its four corners)."""
    w, s, e, n = meta["bbox"]
    N = a.shape[0]
    lats = np.linspace(n, s, N)
    cell = (n - s) / (N - 1) * math.pi / 180 * R_MARS
    c, info = classify(a, lats, cell, meta.get("finest_m", 3705), lander)
    px = np.maximum(np.maximum(c[:-1, :-1], c[1:, :-1]), np.maximum(c[:-1, 1:], c[1:, 1:]))
    return px, info


def overlay(rgb: np.ndarray, px: np.ndarray, verified: bool) -> np.ndarray:
    """Tint an imagery tile (float 0-1, 256 x 256 x 3) with the classes; no-go gets diagonal hatching."""
    out = rgb.copy()
    H, W = px.shape
    yy, xx = np.mgrid[0:H, 0:W]
    hatch = ((xx + yy) // 5) % 2 == 0
    cols = {SAFE: (LEGEND[0] if verified else LEGEND[1]), CAUTION: LEGEND[2], HAZARD: LEGEND[3], NOGO: LEGEND[4]}
    for k, lg in cols.items():
        m = px == k
        if k == NOGO:
            m = m & hatch
        if not m.any():
            continue
        r, g, b, al = lg["rgba"]
        col = np.array([r, g, b], np.float32) / 255.0
        out[m] = out[m] * (1 - al) + col * al
    return out
