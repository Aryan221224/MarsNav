"""Landing-site assessment anywhere on Mars from the global data (the site-scale Monte Carlo with 1 m hazards runs in the
app on a built site: engine/landing.js). Mirrors how NASA screens candidate sites before any detailed work:
  - the lander class sets the ellipse (Viking 300 x 100 km ... Mars 2020 7.7 x 6.6 km ... human-class 50 m accuracy)
  - MSL engineering constraints: elevation <= +1 km, latitude within 45 deg, slope <= 20 deg over 2-10 km,
    relief <= 43 m over 200-1000 m (radar altimetry)
  - Terrain-Relative Navigation needs an orbital map of the ellipse (the Mars 2020 LVS used HiRISE-derived maps at 6 and
    12 m/px): checked against the CTX / HiRISE orthoimage footprints
  - lander-scale hazards (slope over 2-5 m, rocks) can only be verified where 1 m DTMs exist: coverage reported
Sources: MSL Landing Site Selection User's Guide to Engineering Constraints v4.5.1; JPL TRN/LVS; NASA NTRS 20205003002."""
from __future__ import annotations

import math

import numpy as np

from . import catalog, dem
from .config import R_MARS
from .tiling import tile_deg

LANDERS = {
    "viking": {"label": "Viking-class ballistic entry (1976)", "major": 300000, "minor": 100000, "trn": False},
    "mer": {"label": "MER-class (Spirit/Opportunity, 2004)", "major": 150000, "minor": 20000, "trn": False},
    "msl": {"label": "MSL-class guided entry (Curiosity, 2012)", "major": 20000, "minor": 7000, "trn": False},
    "m2020": {"label": "Mars 2020: guided entry + Terrain-Relative Navigation", "major": 7700, "minor": 6600, "trn": True},
    "human": {"label": "Human-class precision lander (50 m requirement)", "major": 150, "minor": 150, "trn": True},
}
LIMITS = {"max_elev_m": 1000, "max_abs_lat": 45, "slope_km_deg": 20, "relief_1km_m": 43}


def ellipse(lon, lat, major, minor, az_deg, n=72):
    az = math.radians(az_deg)
    ux, uy, vx, vy = math.sin(az), math.cos(az), math.cos(az), -math.sin(az)
    out = []
    for k in range(n + 1):
        t = 2 * math.pi * k / n
        a, b = math.cos(t) * major / 2, math.sin(t) * minor / 2
        de, dn = a * ux + b * vx, a * uy + b * vy
        out.append([lon + math.degrees(de / (R_MARS * max(0.02, math.cos(math.radians(lat))))), lat + math.degrees(dn / R_MARS)])
    return out


def assess(lon: float, lat: float, lander: str = "m2020", az_deg: float = 90.0) -> dict:
    L = LANDERS.get(lander, LANDERS["m2020"])
    ell = ellipse(lon, lat, L["major"], L["minor"], az_deg)
    w = min(p[0] for p in ell); e = max(p[0] for p in ell); s = min(p[1] for p in ell); n = max(p[1] for p in ell)
    pad = 0.02
    # elevation over the ellipse at ~200 m (or the finest zoom that keeps the mosaic small)
    span = max(e - w, n - s) + 2 * pad
    z = 5
    for zz in range(5, 15):
        if span / (tile_deg(zz) / 256) <= 900:
            z = zz
    Z, lons, lats, metas = dem.mosaic(z, w - pad, s - pad, e + pad, n + pad)
    cell = abs(lats[1] - lats[0]) * math.pi / 180 * R_MARS
    LON, LAT = np.meshgrid(lons, lats)
    # points inside the ellipse
    az = math.radians(az_deg)
    de = np.radians(LON - lon) * R_MARS * max(0.02, math.cos(math.radians(lat)))
    dn = np.radians(LAT - lat) * R_MARS
    a = de * math.sin(az) + dn * math.cos(az)
    b = de * math.cos(az) - dn * math.sin(az)
    inside = (a / (L["major"] / 2)) ** 2 + (b / (L["minor"] / 2)) ** 2 <= 1
    if inside.sum() < 4:   # tiny ellipse (human lander): use a 1 km neighbourhood for the km-scale checks
        inside = np.hypot(de, dn) <= 1000
    zin = Z[inside]
    zmax = float(np.nanmax(zin)) if np.isfinite(zin).any() else float("nan")
    # slope over ~2 km and relief over ~1 km baselines
    k2 = max(1, int(round(1000 / cell)))
    k1 = max(1, int(round(500 / cell)))
    Zf = np.where(np.isfinite(Z), Z, np.nanmean(Z))

    def diff(k, axis):
        d = np.full(Zf.shape, np.nan)
        if axis == 0 and Zf.shape[0] > 2 * k:
            d[k:-k, :] = Zf[2 * k:, :] - Zf[:-2 * k, :]
        if axis == 1 and Zf.shape[1] > 2 * k:
            d[:, k:-k] = Zf[:, 2 * k:] - Zf[:, :-2 * k]
        return d
    sx, sy = diff(k2, 1), diff(k2, 0)
    slope_km = np.degrees(np.arctan(np.hypot(sx, sy) / (2 * k2 * cell)))
    rel = np.maximum(np.abs(diff(k1, 1)), np.abs(diff(k1, 0)))
    smax = float(np.nanmax(slope_km[inside])) if np.isfinite(slope_km[inside]).any() else float("nan")
    rbad = float(np.nanmean(rel[inside] > LIMITS["relief_1km_m"])) if np.isfinite(rel[inside]).any() else float("nan")
    # detailed-data coverage of the ellipse box
    hir = catalog.query("hirise", w, s, e, n, limit=200)
    ctx = catalog.query("ctx", w, s, e, n, limit=200)

    def box_cover(items):
        if not items:
            return 0.0
        m = np.zeros(Z.shape, bool)
        for it in items:
            bw, bs, be, bn = it["bbox"]
            m |= (LON >= bw) & (LON <= be) & (LAT >= bs) & (LAT <= bn)
        return float(m[inside].mean())
    cov_h, cov_c = box_cover(hir), box_cover(ctx)
    src = sorted({s_["name"] for m in metas for s_ in m["sources"] if s_["frac"] > 0.02})
    checks = [
        {"id": "lat", "label": f"Latitude within +-{LIMITS['max_abs_lat']} deg", "value": f"{lat:.2f} deg", "ok": abs(lat) <= LIMITS["max_abs_lat"]},
        {"id": "elev", "label": f"Elevation <= +{LIMITS['max_elev_m']} m (atmosphere to slow down)", "value": f"{zmax:.0f} m max", "ok": zmax <= LIMITS["max_elev_m"]},
        {"id": "kmslope", "label": f"Slope <= {LIMITS['slope_km_deg']} deg over 2 km", "value": f"{smax:.1f} deg max", "ok": smax <= LIMITS["slope_km_deg"]},
        {"id": "relief", "label": f"Relief <= {LIMITS['relief_1km_m']} m over 1 km (radar altimetry)", "value": f"{100 * rbad:.0f} % of baselines exceed",
         "ok": rbad < 0.05},
        {"id": "trnmap", "label": "Orbital map for Terrain-Relative Navigation (CTX/HiRISE orthoimages)", "value": f"{100 * max(cov_c, cov_h):.0f} % of the ellipse",
         "ok": (max(cov_c, cov_h) > 0.9) if L["trn"] else None},
        {"id": "hazard1m", "label": "Lander-scale hazards verifiable (1 m HiRISE DTMs)", "value": f"{100 * cov_h:.0f} % of the ellipse", "ok": cov_h > 0.5 or None},
    ]
    # the safety classes over the ellipse (planet/safety.py): how much of it is safe, and the nearest safe spot for a hub
    from . import safety
    fin = min((m.get("finest_m", 3705) for m in metas), default=3705)
    cls, sinfo = safety.classify(Z, lats, cell, fin, lander if lander in safety.LIMITS else "human")
    ins = cls[inside]
    frac = {k: round(float((ins == v).mean()), 3) for k, v in (("safe", safety.SAFE), ("caution", safety.CAUTION),
                                                              ("hazard", safety.HAZARD), ("nogo", safety.NOGO))} if ins.size else {}
    tc = cls[int(np.argmin(np.abs(lats - lat))), int(np.argmin(np.abs(lons - lon)))]
    safe_pts = np.argwhere(cls == safety.SAFE)
    best = None
    if safe_pts.size:
        d2 = (LON[safe_pts[:, 0], safe_pts[:, 1]] - lon) ** 2 * math.cos(math.radians(lat)) ** 2 + (LAT[safe_pts[:, 0], safe_pts[:, 1]] - lat) ** 2
        r, c = safe_pts[int(np.argmin(d2))]
        best = {"lon": float(LON[r, c]), "lat": float(LAT[r, c]), "dist_m": round(float(math.sqrt(d2.min()) * math.pi / 180 * R_MARS), 1)}
    names_ = {0: "safe", 1: "caution", 2: "hazard", 3: "no-go"}
    safety_out = {**sinfo, "ellipse": frac, "target_class": names_[int(tc)], "nearest_safe": best}
    return {"ok": True, "lander": lander, "label": L["label"], "target": {"lon": lon, "lat": lat}, "azimuthDeg": az_deg,
            "safety": safety_out,
            "majorM": L["major"], "minorM": L["minor"], "ellipse": ell, "checks": checks, "cell_m": round(cell, 1), "sources": src,
            "hirise_dtms": len(hir), "ctx_dtms": len(ctx),
            "note": "Global screen. Build a site here for the Monte Carlo landing on 1 m hazards and to place the habitat."}
