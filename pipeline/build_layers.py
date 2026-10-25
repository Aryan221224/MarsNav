"""
build_layers.py - derive every planning layer from the terrain statistics (build_terrain.py) and write them in the
compact binary format the engine and the offline app read (app/data/<site out_dir>/*.bin.gz + manifest.json).

    python pipeline/build_layers.py [--site jezero]

Layers on the 10 m operations grid (ops10), all derived from real USGS DTMs:
  elev_dm      uint16  (elevation + 3000 m) * 10                 blended HiRISE 1 m / CTX 20 m
  slope        uint8   deg * 4        slope of the 10 m surface (20 m baseline)
  slopeW       uint8   deg * 4        walking-scale slope, 90th percentile inside the cell (HiRISE); CTX-only cells use the
                                       75th-percentile calibration fitted where both sources overlap (conservative)
  steep        uint8   frac * 255     fraction of the cell steeper than 25 deg at walking scale
  step         uint8   cm             99th-percentile relief step (noise-corrected), capped at 2.55 m
  rough        uint8   cm             RMS relief after a 10 m trend (noise-corrected)
  sand         uint8   * 255          aeolian bedform (ripple / TAR) evidence from 1 m DTM coherence x amplitude
  slipMu       uint8   * 255          expected wheel slip ratio (soft-soil model)
  slipSd       uint8   * 255          slip standard deviation (epistemic: larger where only CTX data exist)
  conf         uint8   * 255          fraction of the cell covered by HiRISE 1 m posts (data confidence)
  cliffDist    uint8   m / 4          distance to the nearest cliff (walking slope > 30 deg over > 30 % of a cell), 4 m steps
  landmark     uint8   m / 10         distance to the nearest navigation landmark (for dead-reckoning drift), 10 m steps
  keepout      uint8   bit flags      1 = mission-hardware / sample-depot keep-out, 2 = planetary-protection zone,
                                       4 = unreliable elevation (regional-DEM blunder, no 1 m DTM) -> "no reliable data",
                                       8 = repaired DEM mosaic seam (passable; routes crossing it are flagged for checking)
  science      uint8   * 255          science value from the target list (kernel density)
  horizon      uint8   deg * 4        horizon elevation angle in 16 azimuth sectors on a 40 m grid (terrain shadowing)
Regional grid (reg100, whole crater): elev_dm only.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import sys
import time

import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from mars_geo import Grid, R_MARS, PROJ, lonlat_to_xy, xy_to_lonlat, haversine_m  # noqa: E402
from sitecfg import cli_site, load_site  # noqa: E402

# MM_ROOT: the project folder (set by the launcher; inside the packaged exe __file__ is in a temporary folder)
ROOT = os.environ.get("MM_ROOT") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WORK = OUT = None   # set per site in main()

N_SECTORS = 16
HORIZON_RES = 40.0
HORIZON_MAX_M = 25000.0


def load(name):
    return np.load(os.path.join(WORK, name))


def slope_deg(z, res):
    gy, gx = np.gradient(z, res)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def elev_encoding(elev):
    """(scale, offset) that fit this site's elevations into uint16 (v = (m + offset) * scale). Mars runs from -8.2 km
    (Hellas) to +21.2 km (Olympus Mons), so a fixed offset cannot work everywhere: Jezero (about -2.5 km) keeps the
    historical 3000 m / 0.1 m; elsewhere the offset follows the site's lowest point, and the step grows (0.1, 0.2, 0.5,
    1 m) only if the relief exceeds what 0.1 m steps can span. 0 stays free as the no-data value."""
    v = np.asarray(elev, np.float64)
    v = v[np.isfinite(v)]
    if not v.size:
        return 10.0, 3000.0
    lo, hi = float(v.min()), float(v.max())
    if lo > -2990 and hi < 3500:
        return 10.0, 3000.0
    off = -np.floor(lo / 100.0) * 100.0 + 100.0          # lowest point lands 100-200 m above the floor
    for sc in (10.0, 5.0, 2.0, 1.0):
        if (hi + off) * sc < 65000:
            return sc, float(off)
    return 1.0, float(off)


def write_layer(name, arr, dtype, manifest, grid_name, scale=1.0, offset=0.0, unit="", desc=""):
    a = np.asarray(arr)
    if np.issubdtype(np.dtype(dtype), np.integer) and name.endswith("elev_dm"):
        # elevation: raw 0 is reserved for "no data"; real values are kept inside 1..max
        info = np.iinfo(dtype)
        bad = ~np.isfinite(a)
        a = np.clip(np.round((np.nan_to_num(a, nan=0.0) + offset) * scale), 1, info.max).astype(dtype)
        a[bad] = 0
    elif np.issubdtype(np.dtype(dtype), np.integer):
        info = np.iinfo(dtype)
        a = np.clip(np.round((np.nan_to_num(a, nan=0.0) + offset) * scale), info.min, info.max).astype(dtype)
    else:
        a = a.astype(dtype)
    raw = a.astype(a.dtype.newbyteorder("<")).tobytes()
    fn = f"{name}.bin.gz"
    with gzip.open(os.path.join(OUT, fn), "wb", compresslevel=9) as f:
        f.write(raw)
    manifest["layers"][name] = {"file": fn, "dtype": np.dtype(dtype).name, "grid": grid_name, "scale": scale,
                                "offset": offset, "unit": unit, "desc": desc, "shape": list(a.shape),
                                "bytes_gz": os.path.getsize(os.path.join(OUT, fn))}
    return a


def sand_evidence(bed_C, bed_E):
    """Aeolian bedforms are both directional (high orientation coherence) and have measurable relief.
    Thresholds chosen from the noise floors measured per DTM (build_terrain report) [ASSUME, documented]."""
    c = np.clip((bed_C - 0.35) / 0.30, 0, 1)
    e = np.clip((bed_E - 0.06) / 0.20, 0, 1)
    ev = np.sqrt(c * e)
    return ndi.gaussian_filter(np.nan_to_num(ev), 1.0)


def slip_model(sand, slopeW, conf):
    """Wheel-slip distribution per cell (ratio 0..1). Mean rises with bedform evidence and slope on sand;
    the standard deviation carries epistemic uncertainty (hidden soft soil, Spirit 2009), larger where the cell
    has no 1 m DTM coverage. Slip classes: low <=0.2, medium 0.2-0.4, high 0.4-0.7, extreme 0.7-1 [SRC, doc 26]."""
    mu = 0.03 + 0.30 * sand + 0.012 * sand * np.clip(slopeW, 0, 30) + 0.004 * np.clip(slopeW - 10, 0, 20)
    sd = 0.03 + 0.12 * sand + 0.10 * (1 - conf)
    return np.clip(mu, 0, 1), np.clip(sd, 0, 1)


def horizon_map(dem_big: np.ndarray, big: Grid, hgrid: Grid) -> np.ndarray:
    """Horizon elevation angle (deg) for each hgrid cell in N_SECTORS azimuths, marching over dem_big with Mars
    curvature (drop = d^2 / 2R). Azimuth sector k is centred on k * 360/N deg clockwise from north."""
    rr, cc = np.mgrid[0:hgrid.height, 0:hgrid.width].astype(np.float64)
    x = hgrid.x0 + (cc + 0.5) * hgrid.res
    y = hgrid.y0 - (rr + 0.5) * hgrid.res
    br = (big.y0 - y) / big.res - 0.5
    bc = (x - big.x0) / big.res - 0.5
    z0 = ndi.map_coordinates(dem_big, [br, bc], order=1, mode="nearest") + 1.7   # eye height of a suited person
    dists = [60.0]
    while dists[-1] < HORIZON_MAX_M:
        dists.append(dists[-1] * 1.06 + 20)
    out = np.zeros((N_SECTORS, hgrid.height, hgrid.width), np.float32)
    for k in range(N_SECTORS):
        az = math.radians(k * 360.0 / N_SECTORS)
        dx, dy = math.sin(az), math.cos(az)
        best = np.full(z0.shape, -90.0)
        for d in dists:
            zr = ndi.map_coordinates(dem_big, [br - dy * d / big.res, bc + dx * d / big.res], order=1, mode="nearest")
            ang = np.degrees(np.arctan2(zr - z0 - d * d / (2 * R_MARS), d))
            np.maximum(best, ang, out=best)
        out[k] = best
        print(f"  horizon sector {k}: max {best.max():.1f} deg", flush=True)
    return out


def landmarks_from_dem(elev: np.ndarray, grid: Grid, n_max=160):
    """Navigation landmarks = locally distinctive terrain (knobs, crater rims, scarp corners) that a crew can see and
    recognise: peaks of |Laplacian of Gaussian| at 60-200 m scale with non-maximum suppression (spacing >= 400 m)."""
    resp = np.zeros_like(elev)
    for s in (6, 12, 20):   # cells (60, 120, 200 m)
        resp = np.maximum(resp, np.abs(ndi.gaussian_laplace(elev, s)) * s * s)
    mx = ndi.maximum_filter(resp, size=41)
    peaks = np.argwhere((resp == mx) & (resp > np.percentile(resp, 97)))
    vals = resp[peaks[:, 0], peaks[:, 1]]
    order = np.argsort(-vals)
    chosen = []
    for i in order:
        r, c = peaks[i]
        if all((r - a) ** 2 + (c - b) ** 2 >= 40 ** 2 for a, b, _ in chosen):
            chosen.append((int(r), int(c), float(vals[i])))
        if len(chosen) >= n_max:
            break
    return chosen


def site_base_and_targets(site, ops, slopeW, cliff_dist, lms, extra=None):
    """Habitat from the site file, or (new site) the gentlest open ground near the centre of the ops area: 300 m
    mean walking slope, at least 200 m from any cliff. With no curated targets, the most distinctive landmarks 1.5-5 km
    from the base become survey stations (kind 'survey', value 0.4): a crew's first sorties at a new site are surveys."""
    b = site.get("base")
    if b is None:
        sm = ndi.uniform_filter(np.nan_to_num(slopeW, nan=45.0), 31)
        rr, cc = np.mgrid[0:ops.height, 0:ops.width]
        dc = np.hypot(rr - ops.height / 2, cc - ops.width / 2) * ops.res
        score = sm + dc / 1000.0 + np.where(cliff_dist < 200, 100, 0)
        land = site.get("landing")
        if land and extra is not None:
            # where a lander can safely come down (MSL engineering limits: slope <= 15 deg over 2-5 m, rocks <= 0.55 m),
            # preferring ground verified by 1 m DTMs; the habitat is where the lander lands
            unsafe = (np.nan_to_num(slopeW, nan=45.0) > 15) | (np.nan_to_num(extra["step"], nan=1.0) > 0.55) | \
                     (np.nan_to_num(extra["sand"]) > 0.6) | (cliff_dist < 10)
            safe300 = ndi.uniform_filter((~unsafe).astype(np.float32), 31)
            verified = np.nan_to_num(extra["conf"]) >= 0.5
            score = score + 50.0 * (1.0 - safe300) + 5.0 * (~verified) + np.where(unsafe, 100, 0)
        r, c = np.unravel_index(np.argmin(score), score.shape)
        lon, lat = xy_to_lonlat(*ops_cell_xy(ops, r, c))
        name = "Habitat (auto-sited: gentlest open ground)"
        if land and extra is not None:
            name = f"Habitat (landing site: lander-safe ground, {land.get('label', land.get('lander', 'lander'))})"
        b = {"id": "HAB", "name": name, "lon": round(lon, 6), "lat": round(lat, 6),
             "auto": True, "mean_slope_300m_deg": round(float(sm[r, c]), 2)}
    auto = []
    if len(site.get("targets") or []) < 3:
        if not any(t.get("id") == "HAB" for t in site.get("targets") or []):
            auto.append({"id": "HAB", "name": b["name"], "kind": "base", "lon": b["lon"], "lat": b["lat"], "value": 0.0,
                         "dwell_min": 0, "why": "Habitat site", "source": "site file" if not b.get("auto") else "auto-sited"})
        cands = []
        for r, c, sal in lms:
            lon, lat = xy_to_lonlat(*ops_cell_xy(ops, r, c))
            d = haversine_m(b["lon"], b["lat"], lon, lat)
            if 1000 <= d <= 4000 and slopeW[r, c] < 18 and cliff_dist[r, c] > 60:
                cands.append((d, lon, lat))
        for k, (d, lon, lat) in enumerate(sorted(cands)[:5], start=1):   # nearest first: the first sorties
            auto.append({"id": f"S{k}", "name": f"Survey station {k} (landmark)", "kind": "science", "lon": round(lon, 6),
                         "lat": round(lat, 6), "value": 0.4, "dwell_min": 30, "sigma_m": 150,
                         "why": f"Distinctive terrain feature {d / 1000:.1f} km from the habitat (landmark detector).",
                         "source": "auto: landmark detector on the site DEM"})
    return b, auto


def _load_out_layer(out_dir, man, name):
    m = man["layers"][name]
    g = man["grids"][m["grid"]]
    a = np.frombuffer(gzip.open(os.path.join(out_dir, m["file"])).read(), dtype=m["dtype"]).astype(np.float32)
    return a.reshape(g["height"], g["width"]) / m["scale"] - m["offset"]


def coarse_calibration(ref_id: str, res_m: float):
    """Walking-scale slope (75th percentile of the 1 m p90, per 0.25 deg bin) against the slope of the reference site's
    elevation block-averaged to res_m and resampled back to 10 m: the relation a coarse-DEM site must use. Real data
    only (the reference site's built layers); cached per resolution."""
    ref = load_site(ref_id)
    cache = os.path.join(ref["work"], f"calib_coarse_{int(round(res_m))}m.json")
    if os.path.exists(cache):
        c = json.load(open(cache))
        return np.array(c["x"]), np.array(c["p75"], dtype=float)
    man = json.load(open(os.path.join(ref["out"], "manifest.json")))
    elev = _load_out_layer(ref["out"], man, "elev_dm")
    sw = _load_out_layer(ref["out"], man, "slopeW")
    conf = _load_out_layer(ref["out"], man, "conf")
    f = max(2, int(round(res_m / 10.0)))
    h, w = (elev.shape[0] // f) * f, (elev.shape[1] // f) * f
    zc = elev[:h, :w].reshape(h // f, f, w // f, f).mean((1, 3))
    zu = ndi.zoom(zc, f, order=1)
    sc = slope_deg(zu, 10.0)
    swc, cf = sw[:h, :w], conf[:h, :w]
    xb = np.arange(0, 20, 0.25)
    p75 = []
    for b in xb:
        m = (cf > 0.9) & (sc >= b) & (sc < b + 0.25)
        p75.append(float(np.percentile(swc[m], 75)) if m.sum() > 200 else float("nan"))
    try:
        json.dump({"x": xb.tolist(), "p75": p75, "res_m": res_m, "ref": ref_id}, open(cache, "w"))
    except OSError:
        pass
    return xb, np.array(p75, dtype=float)


def write_climate(site):
    """Climatology for the engine: fitted from MEDA at Jezero (fit_meda.py); other sites reuse a reference fit, with the
    pressure moved to the local elevation by the hydrostatic term the engine already applies."""
    c = site["sources"].get("climate") or ""
    if c.startswith("from:"):
        ref = load_site(c[5:])
        env = json.load(open(os.path.join(ref["out"], "environment.json")))
        env["source"] = f"{env.get('source', '')} [reused from site {ref['id']}]".strip()
        gen = site.get("generated") or {}
        ref_lat = (ref.get("crater_center") or [0, 18.4])[1]
        if gen.get("lat") is not None and abs(gen["lat"] - ref_lat) > 0.5:
            env = move_climate(env, ref_lat, gen["lat"], gen.get("elev_m"), (ref.get("clock") or {}).get("elev_m", -2550))
        load_site(site["id"])
        json.dump(env, open(os.path.join(site["out"], "environment.json"), "w"))


def _daily_insolation(lat_deg, Ls_deg):
    """Top-of-atmosphere daily-mean insolation (W/m2) on Mars: orbit a = 1.5237 AU, e = 0.0934, perihelion at Ls 251 deg,
    obliquity 25.19 deg (Allison & McEwen 2000 / standard Mars geometry)."""
    lat, Ls = np.radians(lat_deg), np.radians(Ls_deg)
    dec = np.arcsin(np.sin(np.radians(25.19)) * np.sin(Ls))
    r = 1.5237 * (1 - 0.0934 ** 2) / (1 + 0.0934 * np.cos(Ls - np.radians(251.0)))
    x = np.clip(-np.tan(lat) * np.tan(dec), -1, 1)
    H0 = np.arccos(x)
    return 1361.0 / r ** 2 / np.pi * (H0 * np.sin(lat) * np.sin(dec) + np.cos(lat) * np.cos(dec) * np.sin(H0))


def _harm_eval(coef, h, Ls):
    hh, ll = 2 * np.pi * h / 24, np.radians(Ls)
    v = np.zeros_like(hh, dtype=float)
    for (a, b), beta in zip(coef["terms"], coef["beta"]):
        fl = 1 if a == 0 else (np.cos(a * ll) if a > 0 else np.sin(-a * ll))
        fh = 1 if b == 0 else (np.cos(b * hh) if b > 0 else np.sin(-b * hh))
        v = v + beta * fl * fh
    return v


def _harm_fit(terms, h, Ls, V):
    hh, ll = 2 * np.pi * h / 24, np.radians(Ls)
    cols = []
    for a, b in terms:
        fl = np.ones_like(ll) if a == 0 else (np.cos(a * ll) if a > 0 else np.sin(-a * ll))
        fh = np.ones_like(hh) if b == 0 else (np.cos(b * hh) if b > 0 else np.sin(-b * hh))
        cols.append(fl * fh)
    beta, *_ = np.linalg.lstsq(np.stack(cols, 1), V, rcond=None)
    return [float(x) for x in beta]


def move_climate(env, lat_ref, lat_new, elev_new=None, elev_ref=-2550.0):
    """Move a fitted climatology to another latitude (and elevation): temperatures scale with the fourth root of the
    daily insolation at each season (radiative balance, plus ~30 W/m2 of downwelling infrared so the polar night does not
    run to absolute zero), floored at the CO2 frost point (148 K); near-surface air cools ~2.5 K per km of height.
    A first-order physical correction, not a GCM: diurnal amplitude (thermal inertia) and dust are kept from the source."""
    Ls, h = np.meshgrid(np.arange(0, 360, 5.0), np.arange(0, 24, 0.5))
    Ls, h = Ls.ravel(), h.ravel()
    q_ref = _daily_insolation(lat_ref, Ls) + 30.0
    q_new = _daily_insolation(lat_new, Ls) + 30.0
    f = (q_new / q_ref) ** 0.25
    dz = 0.0 if elev_new is None else (elev_new - elev_ref) / 1000.0
    for k in ("ats", "air", "ground"):
        if not isinstance(env.get(k), dict) or "terms" not in env[k]:
            continue
        T = _harm_eval(env[k], h, Ls) * f - (2.5 * dz if k != "ground" else 0.0)
        T = np.maximum(T, 148.0)
        env[k] = {**env[k], "beta": _harm_fit(env[k]["terms"], h, Ls, T)}
    env["source"] += (f"; temperatures moved from latitude {lat_ref:.1f} to {lat_new:.1f} deg by daily insolation"
                      + (f" and {dz:+.1f} km of elevation" if dz else "") + " (first-order radiative correction)")
    env["moved"] = {"from_lat": lat_ref, "to_lat": lat_new, "elev_m": elev_new}
    return env


def write_traverse(site):
    """Rover traverse overlay (context and validation), from NASA's M20 waypoint feed snapshot."""
    fn = site["sources"].get("traverse")
    if not fn:
        return
    w = json.load(open(os.path.join(ROOT, "data_cache", fn)))["waypoints"]
    out = {"source": "NASA/JPL Mars 2020 MMGIS waypoint feed (mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json), "
                     "snapshot mirrored by github.com/enomis-dev/perseverance-traverse-3d",
           "firstSol": w[0]["sol"], "lastSol": w[-1]["sol"], "dist_total_m": w[-1]["dist_total_m"],
           "path": [[round(p["lon"], 6), round(p["lat"], 6)] for p in w]}
    json.dump(out, open(os.path.join(site["out"], "traverse.json"), "w"), separators=(",", ":"))


def hires_used(site):
    """The 1 m DTMs build_terrain actually processed (optional ones may be absent), in tile order."""
    p = os.path.join(site["work"], "hires_used.json")
    return json.load(open(p)) if os.path.exists(p) else [h for h in site["sources"].get("hires_dtms", []) if not h.get("optional")]


def write_sites_index():
    """app/data/sites.json: every site that has been built, for the app's site selector."""
    from sitecfg import SITES
    out = []
    for fn in sorted(os.listdir(SITES)):
        cfg = json.load(open(os.path.join(SITES, fn)))
        path = cfg.get("out_dir", "")
        if not os.path.exists(os.path.join(ROOT, "app", "data", path, "manifest.json")):
            continue
        out.append({"id": cfg["id"], "name": cfg["name"], "short": cfg.get("short", cfg["name"]),
                    "path": (path + "/") if path else "", "description": cfg.get("description", "")})
    out.sort(key=lambda s: s["path"] != "")   # the default site (root data folder) first
    json.dump(out, open(os.path.join(ROOT, "app", "data", "sites.json"), "w"), indent=1)


def main(site: dict):
    global WORK, OUT
    WORK, OUT = site["work"], site["out"]
    t0 = time.time()
    rep = json.load(open(os.path.join(WORK, "terrain_report.json")))
    ops = Grid(**{k: rep["grids"]["ops"][k] for k in ("x0", "y0", "res", "width", "height")}, name="ops10")
    reg = Grid(**{k: rep["grids"]["reg"][k] for k in ("x0", "y0", "res", "width", "height")}, name="reg100")
    elev = load("elev_ops10.npy")
    ctx = load("ctx_ops10.npy")
    cover = np.nan_to_num(load("hi_cover.npy"))
    have = cover > 0.5
    sw = load("hi_sw_p90.npy")
    s10 = slope_deg(elev, ops.res)
    sctx = slope_deg(ctx, ops.res)

    # --- calibration of walking-scale slope for CTX-only cells (fitted on overlap; 75th percentile per 1 deg bin) ---
    h = (cover > 0.9) & np.isfinite(sw)
    xb = np.arange(0, 40, 1.0)
    p75 = []
    for b in xb:
        m = h & (sctx >= b) & (sctx < b + 1)
        p75.append(np.percentile(sw[m], 75) if m.sum() > 200 else np.nan)
    p75 = np.array(p75)
    ok = np.isfinite(p75)
    calib_src = site["id"]
    if ok.sum() < 5:
        # no (or too little) 1 m coverage at this site: reuse the calibration fitted at a reference site
        ref = load_site(site.get("calibration_from", "jezero"))
        cal = json.load(open(os.path.join(ref["out"], "manifest.json")))["calibration"]
        xb, p75 = np.array(cal["ctx_slope_bin_deg"]), np.array(cal["walk_p90_p75"])
        ok = np.isfinite(p75)
        calib_src = ref["id"]
        load_site(site["id"])   # restore this site's projection
    dem_res = float(site.get("dem_res_m") or 20.0)
    if ok.sum() < 5 and dem_res > 30:
        # the regional DEM is much coarser than CTX (HRSC-MOLA 200 m or MOLA 463 m): slopes measured over hundreds of
        # metres are far gentler than slopes underfoot. Calibrate exactly as the CTX case does, but on the reference
        # site's real data degraded to this DEM's resolution: walking-scale slope (1 m DTMs) vs slope of the degraded DEM.
        xb, p75 = coarse_calibration(site.get("calibration_from", "jezero"), dem_res)
        ok = np.isfinite(p75)
        calib_src = f"{site.get('calibration_from', 'jezero')} (degraded to {dem_res:.0f} m)"
        load_site(site["id"])
    p75 = np.interp(xb, xb[ok], p75[ok])
    sw_est = np.interp(sctx, xb + (xb[1] - xb[0]) / 2, p75)
    slopeW = np.where(have & np.isfinite(sw), sw, sw_est)
    steep = np.where(have, np.nan_to_num(load("hi_gt25.npy")), np.clip((sw_est - 18) / 20, 0, 1))
    gt30 = np.where(have, np.nan_to_num(load("hi_gt30.npy")), (sctx > 30).astype(float))
    step = np.where(have, np.nan_to_num(load("hi_step_p99.npy")), 0.25)       # unknown -> assume moderate
    rough = np.where(have, np.nan_to_num(load("hi_rough.npy")), 0.25)
    bedC, bedE = np.nan_to_num(load("hi_bed_C.npy")), np.nan_to_num(load("hi_bed_E.npy"))
    # product quality: USGS metadata warns the crater-rim (CR) pairs have uncompensated y-parallax (striping) outside
    # the ellipse, which the ripple detector can mistake for bedforms -> halve bedform evidence there, widen slip sd
    tile_id = load("hi_tile_id.npy")
    qual = [h.get("quality", 1.0) for h in hires_used(site)] or [1.0]
    q = np.where(tile_id >= 0, np.asarray(qual, float)[np.clip(tile_id, 0, len(qual) - 1)], 1.0)
    sand = np.where(have, sand_evidence(bedC, bedE) * q, 0.25)                 # unknown -> weak prior
    conf = np.clip(cover, 0, 1) * np.where(have, q, 1.0)
    mu, sd = slip_model(sand, slopeW, conf)

    cliff = (gt30 > 0.3) | (s10 > 32)
    cliff = ndi.binary_opening(cliff, iterations=1) | (s10 > 35)
    cliff_dist = ndi.distance_transform_edt(~cliff) * ops.res

    lms = landmarks_from_dem(elev, ops)
    lm_mask = np.zeros(elev.shape, bool)
    for r, c, _ in lms:
        lm_mask[r, c] = True
    lm_dist = ndi.distance_transform_edt(~lm_mask) * ops.res
    base, auto_targets = site_base_and_targets(site, ops, slopeW, cliff_dist, lms,
                                               extra={"step": step, "sand": sand, "conf": conf})

    # --- keep-out zones and science value from the curated target list (targets.py documents each source) ---
    rr, cc = np.mgrid[0:ops.height, 0:ops.width]
    xs = ops.x0 + (cc + 0.5) * ops.res
    ys = ops.y0 - (rr + 0.5) * ops.res
    keep = np.zeros(elev.shape, np.uint8)
    TARGETS, KEEPOUTS = list(site.get("targets", [])) + auto_targets, site.get("keepouts", [])
    for k in KEEPOUTS:
        pts = [lonlat_to_xy(lo, la) for lo, la in k["points"]]
        d = np.full(elev.shape, np.inf)
        for px, py in pts:
            d = np.minimum(d, np.hypot(xs - px, ys - py))
        keep[d <= k["radius_m"]] |= k["flag"]
    # bit 4: regional-DEM blunder (build_terrain.dem_blunders) where no 1 m DTM supersedes it -> "no reliable data"
    bad_path = os.path.join(WORK, "dem_bad.npy")
    if os.path.exists(bad_path):
        keep[np.load(bad_path) & ~have] |= 4
    # bit 8: repaired mosaic seam (build_terrain.dem_seams): passable, but flagged "verify on imagery"
    seam_path = os.path.join(WORK, "dem_seam.npy")
    if os.path.exists(seam_path):
        keep[np.load(seam_path) & ~have] |= 8
    sci = np.zeros(elev.shape)
    for t in TARGETS:
        if t.get("value", 0) <= 0:
            continue
        px, py = lonlat_to_xy(t["lon"], t["lat"])
        sci = np.maximum(sci, t["value"] * np.exp(-((xs - px) ** 2 + (ys - py) ** 2) / (2 * t.get("sigma_m", 150) ** 2)))

    # --- horizon angles on a 40 m grid, DEM big enough to see the crater rim ---
    ctx_reg = load("ctx_reg100.npy")
    big = Grid(reg.x0, reg.y0, reg.res, reg.width, reg.height)
    ctx_fill = np.where(np.isfinite(ctx_reg), ctx_reg, np.nanmean(ctx_reg))
    # use the 10 m elevation where available (nearby shadows) by pasting it onto a 20 m version of the regional DEM
    f = 5
    big20 = Grid(reg.x0, reg.y0, 20.0, reg.width * f, reg.height * f)
    dem20 = ndi.zoom(ctx_fill, f, order=1)[: big20.height, : big20.width]
    r_off = int(round((big20.y0 - ops.y0) / 20.0))
    c_off = int(round((ops.x0 - big20.x0) / 20.0))
    e20 = elev[: ops.height // 2 * 2, : ops.width // 2 * 2].reshape(ops.height // 2, 2, ops.width // 2, 2).mean((1, 3))
    dem20[r_off:r_off + e20.shape[0], c_off:c_off + e20.shape[1]] = e20
    hgrid = Grid(ops.x0, ops.y0, HORIZON_RES, int(ops.width * ops.res / HORIZON_RES), int(ops.height * ops.res / HORIZON_RES))
    hz = horizon_map(dem20, big20, hgrid)

    # --- write everything ---
    manifest = {"version": 2, "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "site": site["name"],
                "site_info": {"id": site["id"], "name": site["name"], "short": site.get("short", site["name"]),
                              "description": site.get("description", ""), "base": base, "clock": site.get("clock"),
                              "ops_area": site["ops_area"], "hires_dtms": [h["key"] for h in hires_used(site)],
                              "regional_dem": site["sources"]["regional_dem"], "calibration_site": calib_src,
                              "climate": site["sources"].get("climate"), "quality_note": site.get("quality_note", ""),
                              "dem_res_m": site.get("dem_res_m", 20), "landing": site.get("landing"), "generated": site.get("generated")},
                "grids": {"ops10": ops.__dict__ | {"name": "ops10"}, "hz40": hgrid.__dict__ | {"name": "hz40"},
                          "reg100": reg.__dict__ | {"name": "reg100"}},
                "projection": {"name": PROJ["name"], "type": "equirectangular", "lat_ts": PROJ["lat_ts"], "clon": PROJ.get("clon", 0.0), "R": R_MARS},
                "horizon": {"sectors": N_SECTORS, "eye_height_m": 1.7},
                "layers": {}, "calibration": {"ctx_slope_bin_deg": xb.tolist(), "walk_p90_p75": p75.tolist()}}
    for g in manifest["grids"].values():
        g.pop("n", None)
    sc, off = elev_encoding(elev)
    write_layer("elev_dm", elev, np.uint16, manifest, "ops10", scale=sc, offset=off, unit="m", desc=f"elevation (m) = v/{sc:g} - {off:g}")
    write_layer("slope", s10, np.uint8, manifest, "ops10", scale=4, unit="deg", desc="10 m surface slope")
    write_layer("slopeW", slopeW, np.uint8, manifest, "ops10", scale=4, unit="deg", desc="walking-scale slope p90")
    write_layer("steep", steep, np.uint8, manifest, "ops10", scale=255, desc="fraction > 25 deg")
    write_layer("step", step, np.uint8, manifest, "ops10", scale=100, unit="m", desc="p99 relief step")
    write_layer("rough", rough, np.uint8, manifest, "ops10", scale=100, unit="m", desc="RMS relief")
    write_layer("sand", sand, np.uint8, manifest, "ops10", scale=255, desc="bedform evidence")
    write_layer("slipMu", mu, np.uint8, manifest, "ops10", scale=255, desc="slip mean")
    write_layer("slipSd", sd, np.uint8, manifest, "ops10", scale=255, desc="slip sd")
    write_layer("conf", conf, np.uint8, manifest, "ops10", scale=255, desc="HiRISE 1 m coverage")
    write_layer("cliffDist", np.minimum(cliff_dist, 1020), np.uint8, manifest, "ops10", scale=0.25, unit="m",
                desc="distance to cliff, 4 m steps, capped 1020 m")
    write_layer("landmark", np.minimum(lm_dist, 2550), np.uint8, manifest, "ops10", scale=0.1, unit="m",
                desc="distance to landmark, 10 m steps, capped 2550 m")
    write_layer("keepout", keep, np.uint8, manifest, "ops10", desc="bit 1 hardware/depot, bit 2 planetary protection, bit 4 unreliable DEM, bit 8 repaired DEM seam")
    write_layer("science", sci, np.uint8, manifest, "ops10", scale=255, desc="science value")
    write_layer("horizon", hz.reshape(N_SECTORS, -1), np.uint8, manifest, "hz40", scale=4, offset=0, unit="deg",
                desc="horizon elevation angle per sector (negative clipped to 0)")
    sc, off = elev_encoding(ctx_fill)
    write_layer("reg_elev_dm", ctx_fill, np.uint16, manifest, "reg100", scale=sc, offset=off, unit="m", desc="regional elevation")
    manifest["landmarks"] = [{"r": r, "c": c, "lonlat": list(xy_to_lonlat(*ops_cell_xy(ops, r, c))), "salience": round(s, 3)}
                             for r, c, s in lms]
    manifest["targets"] = TARGETS
    manifest["keepouts"] = KEEPOUTS
    stats = {"slopeW_mean": float(np.nanmean(slopeW)), "frac_walk_veto20": float((slopeW > 20).mean()),
             "sand_frac_gt05": float((sand > 0.5).mean()), "cliff_cells": int(cliff.sum()), "landmarks": len(lms)}
    manifest["stats"] = stats
    manifest["quality"] = {k: rep[k] for k in ("hirise_vs_ctx", "ctx_vs_trn", "hirise_noise", "dem_blunders", "dem_seams") if k in rep}
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1, default=float)
    np.save(os.path.join(WORK, "horizon40.npy"), hz)
    write_climate(site)
    write_traverse(site)
    write_sites_index()
    tot = sum(v["bytes_gz"] for v in manifest["layers"].values())
    print(json.dumps(stats), f"total {tot / 1e6:.1f} MB gz", f"{time.time() - t0:.0f}s")


def ops_cell_xy(g, r, c):
    return g.x0 + (c + 0.5) * g.res, g.y0 - (r + 0.5) * g.res


if __name__ == "__main__":
    main(cli_site(__doc__.splitlines()[1]))
