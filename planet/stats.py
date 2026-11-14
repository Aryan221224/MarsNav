"""Statistics of the whole-planet layers inside an area (Landing mode): a drawn shape or a landing ellipse.

Like NASA Worldview's area statistics, on Mars data: the area is sampled on an equal-area lattice (spacing chosen for
about `n` points, never finer than the data), and each numeric layer gives its 10th / 50th / 90th percentile, mean,
minimum and maximum, with the share of the area it covers. Layers: MOLA elevation and km-scale slope, TES thermal
inertia and albedo, GRS water-equivalent hydrogen, SWIM ice consistency (1-5 m), modelled surface pressure and cosmic-ray
dose, dust optical depth for a season (planet/dust.py), the crustal magnetic field, and craters >= 1 km (count and
density). Only installed science layers are used."""
from __future__ import annotations

import math

import numpy as np

R_KM = 3396.19


def area_km2(poly) -> float:
    """Spherical polygon area (km^2), Chamberlain & Duquette 2007 (as app/js/measure.js)."""
    s = 0.0
    for k in range(len(poly)):
        (l1, p1), (l2, p2) = poly[k], poly[(k + 1) % len(poly)]
        dl = math.radians(((l2 - l1 + 180) % 360) - 180)
        s += dl * (2 + math.sin(math.radians(p1)) + math.sin(math.radians(p2)))
    return abs(s * R_KM * R_KM / 2)


def _inside(px, py, poly):
    """Even-odd point-in-polygon on unwrapped longitudes (arrays)."""
    x = np.asarray([p[0] for p in poly]); y = np.asarray([p[1] for p in poly])
    ins = np.zeros(px.shape, bool)
    j = len(poly) - 1
    for i in range(len(poly)):
        yi, yj, xi, xj = y[i], y[j], x[i], x[j]
        cond = ((yi > py) != (yj > py)) & (px < (xj - xi) * (py - yi) / ((yj - yi) if yj != yi else 1e-12) + xi)
        ins ^= cond
        j = i
    return ins


def lattice(poly, n: int = 1500):
    """Points inside the polygon on an equal-area lattice: (lon, lat) arrays, and the spacing in km."""
    lon0 = poly[0][0]
    P = [[lon0 + ((lo - lon0 + 180) % 360) - 180, la] for lo, la in poly]          # unwrap across 180 deg
    los = [p[0] for p in P]; las = [p[1] for p in P]
    A = max(area_km2(P), 1e-6)
    step = max(0.02, math.sqrt(A / n))                                           # km between points
    dlat = step / (R_KM * math.pi / 180)
    lat = np.arange(min(las) + dlat / 2, max(las), dlat)
    LO, LA = [], []
    for la in lat:
        dlon = dlat / max(0.05, math.cos(math.radians(la)))
        lo = np.arange(min(los) + dlon / 2, max(los), dlon)
        LO.append(lo); LA.append(np.full(lo.shape, la))
    if not LO:
        return np.array([P[0][0]]), np.array([P[0][1]]), step
    LO, LA = np.concatenate(LO), np.concatenate(LA)
    ok = _inside(LO, LA, P)
    if not ok.any():                                                             # a sliver: use its centroid
        return np.array([np.mean(los)]), np.array([np.mean(las)]), step
    LO = ((LO[ok] + 180) % 360) - 180
    return LO, LA[ok], step


def _st(v, name, unit, digits=1):
    v = np.asarray(v, np.float64)
    good = v[np.isfinite(v)]
    if not good.size:
        return {"name": name, "unit": unit, "n": 0, "cover": 0.0}
    q = np.percentile(good, [10, 50, 90])
    r = lambda x: round(float(x), digits)
    return {"name": name, "unit": unit, "n": int(good.size), "cover": round(good.size / v.size, 3), "p10": r(q[0]), "p50": r(q[1]),
            "p90": r(q[2]), "mean": r(good.mean()), "min": r(good.min()), "max": r(good.max())}


def _elev(megdr, lon, lat):
    """MOLA elevation at points: 463 m where those tiles are here, else 3.7 km; (None, None) before the first download."""
    try:
        e = np.asarray(megdr.sample128(lon, lat, allow_download=False), np.float64)
    except Exception:  # noqa: BLE001 - the 463 m grid is optional here
        e = None
    if e is not None and np.isfinite(e).any():
        return e, "MOLA 463 m"
    e = megdr.sample16(lon, lat, wait=False)
    return (None, None) if e is None else (np.asarray(e, np.float64), "MOLA 3.7 km")


def polygon_stats(poly, ls: float | None = None, n: int = 1500) -> dict:
    from . import atlas, datasets, dust, magnetic, megdr
    if len(poly) < 3:
        raise ValueError("an area needs at least three points")
    LO, LA, step = lattice(poly, n)
    out = {"ok": True, "area_km2": round(area_km2(poly), 3), "points": int(LO.size), "spacing_km": round(step, 3), "layers": {}}
    L = out["layers"]
    el, src = _elev(megdr, LO, LA)
    if el is None:
        out["elevation_missing"] = "MOLA elevation is not on this computer yet (it downloads on first use): pressure-dependent values use the 610 Pa datum"
        p = np.full(LO.shape, 610.0)
    else:
        L["elev"] = {**_st(el, "Elevation", "m", 0), "source": src}
        # km-scale slope from MOLA: elevation differences to points 1.5 km north and east
        d = 1.5
        dla = d / (R_KM * math.pi / 180)
        dlo = dla / np.maximum(0.05, np.cos(np.radians(LA)))
        en, _ = _elev(megdr, LO, LA + dla)
        ee, _ = _elev(megdr, LO + dlo, LA)
        if en is not None and ee is not None:
            L["slope"] = {**_st(np.degrees(np.arctan(np.hypot(en - el, ee - el) / (d * 1000))), "Slope over 1.5 km", "°"), "source": src}
        p = atlas.pressure_pa(el)
        L["pressure"] = _st(p, "Surface pressure (model)", "Pa", 0)
        L["gcr"] = _st(atlas.gcr_dose(el)["ugy_day"], "Cosmic-ray dose (model)", "µGy/day", 0)
    for did, fname, key, name, unit, dg in (("ti", "ti.npy", "ti", "Thermal inertia (TES)", "SI", 0),
                                            ("albedo", "albedo.npy", "albedo", "Albedo (TES)", "", 3),
                                            ("grs", "h2o.npy", "h2o", "Water-equivalent hydrogen (GRS)", "wt %", 1),
                                            ("swim", "ci15.npy", "ice15", "Ice consistency 1-5 m (SWIM)", "Ci", 2)):
        g = datasets._grid(did, fname)
        if g is not None:
            L[key] = _st(datasets.sample(g, LO, LA), name, unit, dg)
    if dust.available():
        season = 250.0 if ls is None else float(ls)
        L["dust"] = {**_st(dust.tau_visible(LO, LA, season, "p50", p), f"Dust optical depth, Ls {season:.0f}° (median year)", "τ", 2),
                     "ls": season}
        L["dust90"] = _st(dust.tau_visible(LO, LA, season, "p90", p), f"Dust optical depth, Ls {season:.0f}° (dusty year, p90)", "τ", 2)
    if magnetic.available():
        L["mag"] = _st(np.abs(magnetic.sample(LO, LA, "br")), "Crustal field |Br| at 400 km (MGS)", "nT", 0)
    # craters >= 1 km whose centres fall inside the shape
    lon0 = poly[0][0]
    P = [[lon0 + ((lo - lon0 + 180) % 360) - 180, la] for lo, la in poly]
    cb = datasets.craters_in_box(min(q[0] for q in P), min(q[1] for q in P), max(q[0] for q in P), max(q[1] for q in P))
    if cb is not None:
        cl, ca, cd = cb[0], cb[1], cb[2]
        cl = lon0 + ((np.asarray(cl, np.float64) - lon0 + 180) % 360) - 180
        ins = _inside(cl, np.asarray(ca, np.float64), P) if len(cl) else np.zeros(0, bool)
        A = max(out["area_km2"], 1e-9)
        out["craters"] = {"count": int(ins.sum()), "per_1e6_km2": round(float(ins.sum() / A * 1e6)),
                          "largest_km": round(float(np.asarray(cd)[ins].max()), 1) if ins.any() else None}
    return out
