"""Route anywhere on Mars: least-cost paths between any points, on the streamed real elevation, coarse to fine
(the same idea as a flight simulator's level of detail): a first path over the whole leg at a zoom where the leg spans
about a thousand cells, then refinements inside a corridor around it at finer zooms, down to 200 m (HRSC-MOLA) for long
traverses and CTX 20 m where CTX DTMs exist for short ones. Slopes over the vehicle's limit are impassable; steeper
ground costs more; climbing costs more than descending.

This is strategic, long-range routing (days to months of driving); the EVA-scale planning with walk-home guarantees,
consumables and hazards at 1 m runs on a site built at either end ("Build site here")."""
from __future__ import annotations

import math
import time

import numpy as np

from . import dem
from .config import R_MARS, DEM_N
from .tiling import haversine_m, tile_deg

MODES = {
    "crewed_rover": {"label": "Crewed pressurised rover", "max_slope": 20.0, "kmh": 10.0, "hours_per_sol": 8.0,
                     "note": "[ASSUME] NASA pressurised-rover class: ~10 km/h cruise, 8 h driving per sol, 20 deg slope limit"},
    "robotic_rover": {"label": "Robotic rover (Perseverance-class)", "max_slope": 25.0, "kmh": 0.12, "hours_per_sol": 4.0,
                      "note": "Perseverance top speed 0.152 km/h [NASA]; [ASSUME] 0.12 km/h average with AutoNav, 4 h driving per sol"},
    "walk": {"label": "Suited walk", "max_slope": 20.0, "kmh": 2.7, "hours_per_sol": 6.0,
             "note": "Apollo long-walk planning speed 2.7 km/h; NASA 20 deg slope limit for suited crew [SRC]"},
}


def _zoom_for_span(span_deg: float, cells: int = 1024) -> int:
    for z in range(0, 17):
        if span_deg / (tile_deg(z) / (DEM_N - 1)) >= cells:
            return z
    return 16


def _solve(Z: np.ndarray, lons: np.ndarray, lats: np.ndarray, start_rc, goal_rc, mode: dict, mask: np.ndarray | None = None,
           slope_penalty: bool = True):
    """Dijkstra on the 8-connected lon/lat grid (scipy csgraph), directed costs. Returns list of (r, c) or None."""
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    H, Wd = Z.shape
    Zf = np.where(np.isfinite(Z), Z, np.nanmean(Z))
    dlat = abs(lats[1] - lats[0]) if len(lats) > 1 else 1.0
    dlon = abs(lons[1] - lons[0]) if len(lons) > 1 else 1.0
    dy = dlat * math.pi / 180 * R_MARS
    dx = dlon * math.pi / 180 * R_MARS * np.maximum(0.02, np.cos(np.radians(lats)))[:, None] * np.ones((1, Wd))
    ids = np.arange(H * Wd).reshape(H, Wd)
    keep = np.ones((H, Wd), bool) if mask is None else mask
    src_l, dst_l, cost_l = [], [], []
    smax = mode["max_slope"]
    for dr, dc in ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)):
        rs = slice(max(0, -dr), H - max(0, dr))
        cs = slice(max(0, -dc), Wd - max(0, dc))
        rd = slice(max(0, dr), H - max(0, -dr))
        cd = slice(max(0, dc), Wd - max(0, -dc))
        ok = keep[rs, cs] & keep[rd, cd]
        dist = np.hypot(dc * dx[rs, cs], dr * dy)
        dz = Zf[rd, cd] - Zf[rs, cs]
        slope = np.degrees(np.arctan(np.abs(dz) / np.maximum(dist, 1e-3)))
        if slope_penalty:
            ok &= slope <= smax
        c = dist * (1.0 + 2.5 * (slope / smax) ** 2) + 8.0 * np.maximum(dz, 0)   # [ASSUME] climbing costs ~8 m per m of rise
        src_l.append(ids[rs, cs][ok])
        dst_l.append(ids[rd, cd][ok])
        cost_l.append(c[ok])
    src = np.concatenate(src_l)
    dst = np.concatenate(dst_l)
    cost = np.concatenate(cost_l).astype(np.float64)
    G = csr_matrix((cost, (src, dst)), shape=(H * Wd, H * Wd))
    s_id = ids[start_rc]
    g_id = ids[goal_rc]
    dist, pred = dijkstra(G, directed=True, indices=s_id, return_predecessors=True, limit=np.inf)
    if not np.isfinite(dist[g_id]):
        return None
    path = []
    v = g_id
    while v != s_id and v >= 0:
        path.append(divmod(int(v), Wd))
        v = pred[v]
    path.append(divmod(int(s_id), Wd))
    return path[::-1]


def _rc(lons, lats, lon, lat):
    c = int(round((lon - lons[0]) / (lons[1] - lons[0])))
    r = int(round((lats[0] - lat) / (lats[0] - lats[1])))
    return min(len(lats) - 1, max(0, r)), min(len(lons) - 1, max(0, c))


def _leg(a, b, mode, log, max_cells=1_600_000):
    lon_a, lat_a = a
    lon_b, lat_b = b
    # the short way round: unwrap b's longitude next to a's
    while lon_b - lon_a > 180:
        lon_b -= 360
    while lon_b - lon_a < -180:
        lon_b += 360
    span = max(abs(lon_b - lon_a) * max(0.1, math.cos(math.radians((lat_a + lat_b) / 2))), abs(lat_b - lat_a), 0.02)
    levels = []
    t0 = time.time()
    path = None
    relaxed = False
    # widen the search box until a path within the slope limit exists (a barrier may force a long detour), then, as a
    # last resort, show the least-steep path and say so
    for padf in (0.35, 1.0, 2.5, 6.0):
        pad = max(padf * span, 0.01)
        cl = max(0.1, math.cos(math.radians((lat_a + lat_b) / 2)))
        w, e = min(lon_a, lon_b) - pad / cl, max(lon_a, lon_b) + pad / cl
        if e - w > 359:
            w, e = (lon_a + lon_b) / 2 - 179.5, (lon_a + lon_b) / 2 + 179.5
        s, n = max(-89.9, min(lat_a, lat_b) - pad), min(89.9, max(lat_a, lat_b) + pad)
        zc = min(12, _zoom_for_span(max(e - w, n - s), 600))
        log(f"coarse pass at zoom {zc} over {e - w:.2f} x {n - s:.2f} deg")
        Z, lons, lats, metas = dem.mosaic(zc, w, s, e, n)
        r0 = int(np.searchsorted(-lats, -n)); r1 = int(np.searchsorted(-lats, -s))
        c0 = int(np.searchsorted(lons, w)); c1 = int(np.searchsorted(lons, e))
        Z, lons, lats = Z[r0:r1 + 1, c0:c1 + 1], lons[c0:c1 + 1], lats[r0:r1 + 1]
        path = _solve(Z, lons, lats, _rc(lons, lats, lon_a, lat_a), _rc(lons, lats, lon_b, lat_b), mode)
        if path is not None:
            break
        log("no path within the slope limit inside this box: widening the search")
    if path is None:
        log("no path within the slope limit found: showing the least-steep path instead")
        path = _solve(Z, lons, lats, _rc(lons, lats, lon_a, lat_a), _rc(lons, lats, lon_b, lat_b), mode, slope_penalty=False)
        relaxed = True
    levels.append({"zoom": zc, "cell_m": round(abs(lats[1] - lats[0]) * math.pi / 180 * R_MARS, 1), "cells": int(Z.size),
                   "sources": sorted({s_["name"] for m in metas for s_ in m["sources"] if s_["frac"] > 0.02})})
    ll = [(float(lons[c]), float(lats[r]), float(Z[r, c])) for r, c in path]
    # refine inside a corridor, two zooms at a time, while the corridor stays affordable
    z = zc
    while path is not None and z < 12:
        zf = min(12, z + 2)
        cell_deg = tile_deg(zf) / (DEM_N - 1)
        length_cells = sum(haversine_m(ll[i][0], ll[i][1], ll[i + 1][0], ll[i + 1][1]) for i in range(len(ll) - 1)) / (cell_deg * math.pi / 180 * R_MARS)
        width = 24
        if length_cells * width * 2 > max_cells:
            break
        lo = np.array([p[0] for p in ll]); la = np.array([p[1] for p in ll])
        bw, be = lo.min() - width * cell_deg * 2, lo.max() + width * cell_deg * 2
        bs, bn = max(-89.9, la.min() - width * cell_deg), min(89.9, la.max() + width * cell_deg)
        if (be - bw) / cell_deg * (bn - bs) / cell_deg > 60_000_000:
            break
        log(f"refining at zoom {zf} ({cell_deg * math.pi / 180 * R_MARS:.0f} m cells) in a corridor around the path")
        Zf, lf, af, mf = dem.mosaic(zf, bw, bs, be, bn)
        # corridor mask: cells within `width` of the previous path
        from scipy import ndimage as ndi
        mask = np.zeros(Zf.shape, bool)
        for (plon, plat, _z) in ll:
            r, c = _rc(lf, af, plon, plat)
            mask[r, c] = True
        # densify between consecutive coarse points so the corridor is continuous
        for i in range(len(ll) - 1):
            ra, ca = _rc(lf, af, ll[i][0], ll[i][1]); rb, cb = _rc(lf, af, ll[i + 1][0], ll[i + 1][1])
            k = max(abs(ra - rb), abs(ca - cb), 1)
            for t in range(k + 1):
                mask[int(round(ra + (rb - ra) * t / k)), int(round(ca + (cb - ca) * t / k))] = True
        mask = ndi.binary_dilation(mask, iterations=width)
        if mask.sum() > max_cells:
            break
        sa, ga = _rc(lf, af, lon_a, lat_a), _rc(lf, af, lon_b, lat_b)
        mask[sa] = mask[ga] = True
        p2 = _solve(Zf, lf, af, sa, ga, mode, mask=mask, slope_penalty=not relaxed)
        if p2 is None and not relaxed:
            p2 = _solve(Zf, lf, af, sa, ga, mode, mask=mask, slope_penalty=False)
            relaxed = True
        if p2 is None:
            break
        path = p2
        ll = [(float(lf[c]), float(af[r]), float(Zf[r, c])) for r, c in path]
        levels.append({"zoom": zf, "cell_m": round(cell_deg * math.pi / 180 * R_MARS, 1), "cells": int(mask.sum()),
                       "sources": sorted({s_["name"] for m in mf for s_ in m["sources"] if s_["frac"] > 0.02})})
        z = zf
    log(f"leg solved in {time.time() - t0:.1f} s")
    return ll, levels, relaxed


def route(points: list, mode_id: str = "crewed_rover", log=print) -> dict:
    mode = MODES.get(mode_id, MODES["crewed_rover"])
    allpts, legs = [], []
    for i in range(len(points) - 1):
        ll, levels, relaxed = _leg(points[i], points[i + 1], mode, log)
        legs.append({"from": points[i], "to": points[i + 1], "levels": levels, "relaxed": relaxed})
        allpts.extend(ll if not allpts else ll[1:])
    # profile and statistics along the final path
    prof = []
    d = up = down = 0.0
    smax = 0.0
    over = 0.0
    for i, (lo, la, z) in enumerate(allpts):
        if i:
            plo, pla, pz = allpts[i - 1]
            h = haversine_m(plo, pla, lo, la)
            dz = z - pz
            d += h
            up += max(dz, 0); down += max(-dz, 0)
            sl = math.degrees(math.atan(abs(dz) / max(h, 1e-3)))
            smax = max(smax, sl)
            if sl > mode["max_slope"]:
                over += h
        else:
            sl = 0.0
        prof.append([round(((lo + 180) % 360) - 180, 6), round(la, 6), round(z, 1), round(d, 1), round(sl, 2)])
    # thin the profile for display (keep every point for short routes)
    step = max(1, len(prof) // 4000)
    pts = prof[::step] + ([prof[-1]] if (len(prof) - 1) % step else [])
    straight = sum(haversine_m(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]) for i in range(len(points) - 1))
    hours = d / 1000 / mode["kmh"]
    finest = min(l["cell_m"] for lg in legs for l in lg["levels"]) if legs else None
    return {
        "ok": True, "mode": mode_id, "mode_label": mode["label"], "assumptions": mode["note"],
        "distance_m": round(d, 1), "straight_m": round(straight, 1), "ascent_m": round(up, 1), "descent_m": round(down, 1),
        "max_slope_deg": round(smax, 2), "over_limit_m": round(over, 1),
        "drive_hours": round(hours, 2), "sols": round(hours / mode["hours_per_sol"], 1),
        "finest_cell_m": finest, "legs": legs, "points": pts,
        "warning": ("Slopes measured at %s m resolution: hazards smaller than that are not resolved. Build a site at each end "
                    "for EVA-scale planning." % (round(finest) if finest else "?")),
    }
