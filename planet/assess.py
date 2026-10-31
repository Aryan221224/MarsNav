"""Hub-site dossier: everything a crew landing site is judged on, at one point, with a go / caution / no-go verdict per
criterion and an overall score. Used by Landing mode to pick the place where astronauts land and set up the hub.

Criteria sets (both published):
  hls2      NASA Human Landing Sites / Exploration Zones workshop call (2015): latitude within 50 deg, elevation below
            +2 km, a generally level landing area (slopes under ~10 deg), no major hazards (large or dense craters,
            chaotic terrain, dune fields), no thick fine dust, a water resource (>100 t) inside the 100 km Exploration Zone,
            infrastructure within 5 km of the landing site.
  starship  Golombek et al. 2021 (LPSC 52 #2420, SpaceX Starship site study): latitude under 40 deg, elevation below
            -2 km (-3 km preferred), slopes under 5 deg over 10 m, thermal inertia at least 100, and evidence of shallow
            ice that can be reached.
The landing checks (ellipse, km-scale slope and relief, safety classes, TRN map) come from planet/landing.py; resources
and surface properties from planet/datasets.py; the environment is computed from latitude and elevation."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from . import datasets, landing, megdr, names
from .config import PATHS

CRITERIA = {
    "hls2": {"label": "NASA Human Landing Sites (2015)", "lat": 50.0, "lat_caution": 40.0, "elev_m": 2000.0, "elev_good_m": -1000.0,
             "slope_deg": 10.0, "ti_min": 100.0, "ice_km": 100.0, "infra_km": 5.0},
    "starship": {"label": "SpaceX Starship study (Golombek et al. 2021)", "lat": 40.0, "lat_caution": 35.0, "elev_m": -2000.0,
                 "elev_good_m": -3000.0, "slope_deg": 5.0, "ti_min": 100.0, "ice_km": 100.0, "infra_km": 5.0},
}
WEIGHTS = {"lat": 8, "elev": 10, "landing": 22, "slope": 8, "dust": 10, "ice": 22, "craters": 8, "trn": 6, "verify": 6}


def candidates() -> dict:
    for p in (PATHS.get("root", Path(".")) / "planet" / "data" / "candidates.json", Path(__file__).parent / "data" / "candidates.json"):
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return {"ez": [], "starship": [], "heritage": [], "sources": {}}


def _hav_km(a_lon, a_lat, b_lon, b_lat):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lon - a_lon) / 2) ** 2
    return 2 * 3396.19 * math.asin(min(1.0, math.sqrt(h)))


# ------------------------------------------------------------------ environment from latitude and elevation

def insolation(lat_deg: float) -> dict:
    """Top-of-atmosphere daily-mean sunlight over a Mars year at this latitude (W/m^2): mean, minimum (the darkest sol,
    which sizes a solar power system) and maximum. Obliquity 25.19 deg, eccentricity 0.0934, perihelion at Ls 251 deg,
    1 AU solar constant 1361 W/m^2, semi-major axis 1.5237 AU."""
    phi = math.radians(lat_deg)
    eps, e, lsp = math.radians(25.19), 0.0934, math.radians(251.0)
    vals = []
    for k in range(360):
        ls = math.radians(k + 0.5)
        dec = math.asin(math.sin(eps) * math.sin(ls))
        r = 1.5237 * (1 - e * e) / (1 + e * math.cos(ls - lsp))
        s0 = 1361.0 / r ** 2
        x = -math.tan(phi) * math.tan(dec)
        h0 = math.pi if x <= -1 else 0.0 if x >= 1 else math.acos(x)
        q = s0 / math.pi * (h0 * math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.sin(h0))
        # weight by the time Mars spends at this Ls (Kepler: dt ~ r^2 dLs)
        vals.append((q, r * r))
    wsum = sum(w for _q, w in vals)
    mean = sum(q * w for q, w in vals) / wsum
    return {"mean_wm2": round(mean, 1), "min_wm2": round(min(q for q, _w in vals), 1), "max_wm2": round(max(q for q, _w in vals), 1)}


def environment(lat: float, elev_m: float | None) -> dict:
    h = elev_m if elev_m is not None and math.isfinite(elev_m) else 0.0
    p = 610.0 * math.exp(-h / 11100.0)                    # [ASSUME] 610 Pa mean at the datum, 11.1 km scale height
    col = p / 3.711                                        # kg/m^2 of air overhead
    sun = insolation(lat)
    tau = 0.5                                              # [ASSUME] typical clear-season dust optical depth
    k = 0.65 if tau <= 0.5 else 0.5                        # [ASSUME] daily-mean surface / top-of-atmosphere at tau 0.5
    return {"pressure_pa": round(p, 0), "column_g_cm2": round(col / 10, 1), "sun_toa": sun,
            "sun_surface_mean_wm2": round(sun["mean_wm2"] * k, 0), "sun_surface_min_wm2": round(sun["min_wm2"] * k, 0),
            "notes": "Pressure from a 610 Pa datum mean and 11.1 km scale height; shielding is the air column (g/cm^2) over the "
                     "crew; sunlight is top-of-atmosphere, averaged per sol, and at the surface for dust optical depth 0.5 [ASSUME]."}


# ------------------------------------------------------------------ criteria

def _row(rid, group, label, value, limit, status, source, note=""):
    return {"id": rid, "group": group, "label": label, "value": value, "limit": limit, "status": status, "source": source, "note": note}


def evaluate(lat, lon, elev_m, D, crat, ice, L, crit="hls2"):
    """Criteria rows from the collected data. L (landing.assess) may be None for the quick screen."""
    C = CRITERIA.get(crit, CRITERIA["hls2"])
    rows = []
    a = abs(lat)
    rows.append(_row("lat", "Engineering", f"Latitude within {C['lat']:.0f} deg", f"{lat:+.2f} deg", f"|lat| <= {C['lat']:.0f} deg",
                     "go" if a <= C["lat_caution"] else "caution" if a <= C["lat"] else "nogo",
                     C["label"], "Higher latitudes: colder, less sunlight, harder EDL geometry, but more shallow ice."))
    if elev_m is not None and math.isfinite(elev_m):
        rows.append(_row("elev", "Engineering", "Elevation low enough to slow down (atmosphere)", f"{elev_m:,.0f} m",
                         f"<= {C['elev_m']:+,.0f} m (better below {C['elev_good_m']:+,.0f} m)",
                         "go" if elev_m <= C["elev_good_m"] else "caution" if elev_m <= C["elev_m"] else "nogo",
                         "MOLA elevation; " + C["label"], "More air overhead also shields the crew from radiation."))
    if L is not None:
        sf = L.get("safety") or {}
        fr = sf.get("ellipse") or {}
        tc = sf.get("target_class")
        safe = (fr.get("safe") or 0)
        st = "go" if tc == "safe" and safe >= 0.8 else "nogo" if tc in ("hazard", "no-go") else "caution"
        rows.append(_row("landing", "Landing", "Touchdown point and ellipse on safe ground",
                         f"point: {tc}; ellipse {100 * safe:.0f} % safe, {100 * (fr.get('hazard') or 0):.0f} % hazard",
                         "point safe, ellipse >= 80 % safe", st,
                         f"slope and relief from MOLA / HRSC / CTX / HiRISE elevation at {sf.get('baseline_m', '?')} m",
                         "" if sf.get("verified") else "Candidate only: rocks and scarps smaller than the data are not seen."))
        chk = {c["id"]: c for c in L.get("checks", [])}
        km = chk.get("kmslope")
        if km:
            try:
                smax = float(str(km["value"]).split()[0])
            except ValueError:
                smax = float("nan")
            rows.append(_row("slope", "Landing", f"Generally level landing area (slopes under {C['slope_deg']:.0f} deg)",
                             km["value"], f"<= {C['slope_deg']:.0f} deg",
                             "go" if smax <= C["slope_deg"] * 0.6 else "caution" if smax <= C["slope_deg"] else "nogo" if smax > 20 else "caution",
                             "km-scale slope over the ellipse (2 km baseline)"))
        trn = chk.get("trnmap")
        if trn:
            rows.append(_row("trn", "Landing", "Orbital map for Terrain-Relative Navigation", trn["value"], "> 90 % of the ellipse",
                             "go" if trn["ok"] is not False else "caution", "CTX / HiRISE orthoimage footprints",
                             "The CTX global mosaic (5 m) also covers nearly every site."))
        ver = chk.get("hazard1m")
        if ver:
            rows.append(_row("verify", "Landing", "Lander-scale hazards verifiable (1 m HiRISE elevation)", ver["value"], "> 50 %",
                             "go" if ver["ok"] else "caution", "USGS HiRISE DTM footprints",
                             "Without HiRISE a crewed site needs new imaging before commitment."))
    ti = (D.get("ti") or {}).get("value") if D.get("ti") else None
    if D.get("ti") is not None:
        rows.append(_row("dust", "Surface", "No thick fine dust (bearing strength, dust on hardware)",
                         "no data" if ti is None else f"{ti:.0f} SI · {datasets.ti_class(ti, lat)}", f">= {C['ti_min']:.0f} SI",
                         "unknown" if ti is None else "go" if ti >= 150 else "caution" if ti >= C["ti_min"] else "nogo",
                         "TES thermal inertia, Putzig & Mellon 2007"))
    if ice is not None:
        if ice.get("outside"):
            rows.append(_row("ice", "Resources", "Water ice reachable for ISRU (within the 100 km zone)", "outside SWIM's 60 S-60 N map",
                             "Ci >= 0.5 at 0-5 m", "unknown", "SWIM (PSI / NASA)", "Poleward of 60 deg shallow ice is common (Phoenix dug into it at 68 N)."))
        elif ice.get("found"):
            d = ice["dist_km"]
            rows.append(_row("ice", "Resources", "Water ice reachable for ISRU",
                             f"Ci {ice['ci']:+.2f} at {ice['depth']}, {d:.0f} km away", f"Ci >= 0.5 within {C['infra_km']:.0f} km (go) / {C['ice_km']:.0f} km",
                             "go" if d <= C["infra_km"] else "caution", "SWIM ice consistency (Morgan et al. 2021, 2025)",
                             f"{100 * ice.get('share_within_km', 0):.0f} % of the 100 km zone is ice-consistent."))
        else:
            b = ice.get("best_ci")
            rows.append(_row("ice", "Resources", "Water ice reachable for ISRU", "none within 100 km" + (f" (best Ci {b:+.2f})" if b is not None else ""),
                             "Ci >= 0.5 at 0-5 m", "nogo", "SWIM ice consistency (Morgan et al. 2021, 2025)",
                             "Water would have to come from hydrated minerals or be shipped."))
    elif D.get("grs_h2o_wt") is not None:
        # SWIM not installed (or its server was down): the Odyssey GRS hydrogen map still tells ice-rich ground from dry
        h = D["grs_h2o_wt"]
        rows.append(_row("ice", "Resources", "Water for ISRU (near-surface hydrogen)", f"{h:.0f} wt% water-equivalent in the top ~0.5 m",
                         ">= 10 wt% (ground ice likely)",
                         "go" if h >= 10 else "caution",      # GRS sees only ~0.5 m: dry at the top is not proof of no ice
                         "Mars Odyssey GRS, Boynton et al. 2007 (5 deg cells)",
                         "Coarse: install the SWIM layer (Data tab) for ice at 3 km and 0-5 m depth. Below ~8 wt% the water "
                         "is mostly in hydrated minerals (costly to extract)."))
    elif D.get("installed", {}).get("grs") or D.get("installed", {}).get("swim"):
        rows.append(_row("ice", "Resources", "Water for ISRU", "no water data at this latitude",
                         "Ci >= 0.5 at 0-5 m", "unknown", "SWIM covers 60 S - 60 N; GRS masks the seasonal-frost latitudes",
                         "Poleward of ~55 deg shallow ground ice is common (Phoenix dug into it at 68 N)."))
    if crat is not None:
        ins = crat.get("inside")
        n10, n5 = crat.get("count") or 0, crat.get("count_5km") or 0
        if ins:
            D_km, rim = ins["diameter_km"], ins["rim_km"]
            wall = min(8.0, max(2.0, 0.08 * D_km))   # the wall and rim apron of a crater, roughly
            if D_km < 5 or (rim < wall and D_km < 100):
                st = "nogo"                            # on a small crater's floor (a bowl: all slope) or on a crater wall
            elif rim < wall:
                st = "caution"                         # near the rim of a large, usually degraded basin: the slope check decides
            elif rim < max(5.0, 0.15 * D_km) or n5 > 0 or n10 >= 6:
                st = "caution"
            else:
                st = "go"                              # the floor of a large crater far from its walls (Gale, Jezero)
            val = f"inside a {D_km:.1f} km crater, {rim:.1f} km from its rim"
        else:
            st = "caution" if n5 > 0 or n10 >= 6 else "go"
            val = "not inside a crater of 1 km or more"
        val += f"; {n10} crater{'s' if n10 != 1 else ''} >= 1 km within {crat['radius_km']:.0f} km"
        rows.append(_row("craters", "Surface", "Not on a crater wall; few craters around the landing area", val,
                         "clear of walls; < 6 craters >= 1 km and none >= 5 km within 10 km",
                         st, "Robbins & Hynek crater database (2020)", "Crater walls and fresh ejecta are the rockiest ground."))
    return rows


def score(rows) -> dict:
    pts = tot = 0.0
    for r in rows:
        w = WEIGHTS.get(r["id"], 5)
        if r["status"] == "unknown":
            continue
        tot += w
        pts += w * {"go": 1.0, "caution": 0.5, "nogo": 0.0}[r["status"]]
    hard = {"lat", "elev", "landing"}
    verdict = ("NO-GO" if any(r["status"] == "nogo" and r["id"] in hard for r in rows)
               else "CAUTION" if any(r["status"] in ("nogo", "caution") for r in rows) else "GO")
    return {"score": round(100 * pts / tot) if tot else None, "verdict": verdict,
            "counts": {s: sum(1 for r in rows if r["status"] == s) for s in ("go", "caution", "nogo", "unknown")}}


def context(lon, lat) -> dict:
    cand = candidates()
    ez = sorted(({**e, "dist_km": round(_hav_km(lon, lat, e["lon"], e["lat"]), 1)} for e in cand.get("ez", [])), key=lambda e: e["dist_km"])[:3]
    her = sorted(({**h, "dist_km": round(_hav_km(lon, lat, h["lon"], h["lat"]), 1)} for h in cand.get("heritage", [])), key=lambda h: h["dist_km"])[:2]
    ss = sorted(({**s, "dist_km": round(_hav_km(lon, lat, s["lon"], s["lat"]), 1)} for s in cand.get("starship", [])), key=lambda s: s["dist_km"])[:1]
    try:
        nm = names.nearest(lon, lat, k=4)
    except Exception:  # noqa: BLE001
        nm = []
    return {"ez": ez, "heritage": her, "starship": ss, "names": nm}


def dossier(lon: float, lat: float, lander: str = "human", az: float = 90.0, crit: str = "hls2") -> dict:
    """The full assessment at one point (slow part: the elevation mosaic over the ellipse in landing.assess)."""
    L = landing.assess(lon, lat, lander, az)
    try:
        e16 = float(megdr.sample128(np.array([lon]), np.array([lat]), allow_download=False)[0])
    except Exception:  # noqa: BLE001
        e16 = None
    D = datasets.point(lon, lat)
    crat = datasets.craters_near(lon, lat, 10.0)
    crat_zone = datasets.craters_near(lon, lat, 100.0)
    ice = datasets.ice_near(lon, lat, 100.0)
    rows = evaluate(lat, lon, e16, D, crat, ice, L, crit)
    sc = score(rows)
    geo = datasets.geology_at(lon, lat)
    from . import atlas, features, science
    try:
        objs = sorted((science.evaluate(o["id"], lon, lat, e16) for o in science.objectives().get("objectives", [])), key=lambda r: -r["score"])
        for r in objs:
            r["title"] = science.objective(r["objective"])["title"]
    except Exception as e:  # noqa: BLE001 - a missing catalogue never breaks the dossier
        objs = [{"error": f"{type(e).__name__}: {e}"}]
    return {"ok": True, "target": {"lon": lon, "lat": lat}, "criteria_set": crit, "criteria_label": CRITERIA.get(crit, CRITERIA["hls2"])["label"],
            "elev_m": e16, "landing": L, "data": D, "craters": crat, "craters_zone": crat_zone, "ice": ice, "geology": geo,
            "environment": environment(lat, e16), "model": atlas.point(lon, lat, e16), "context": context(lon, lat),
            "science": features.context(lon, lat, 100.0) if features.available() else None, "objectives": objs,
            "criteria": rows, **sc,
            "datasets": {k: {"installed": v["installed"], "name": v["name"], "cite": v["cite"]} for k, v in datasets.status().items()}}


def screen(points: list, crit: str = "hls2") -> list:
    """Quick screen of many candidates from the global data only (no elevation mosaic, no landing ellipse)."""
    out = []
    lons = np.array([p[0] for p in points], np.float64)
    lats = np.array([p[1] for p in points], np.float64)
    try:
        el = megdr.sample16(lons, lats)
    except Exception:  # noqa: BLE001
        el = np.full(len(points), np.nan)
    for (lon, lat, pid), e in zip(points, el):
        D = datasets.point(lon, lat)
        crat = datasets.craters_near(lon, lat, 10.0)
        ice = datasets.ice_near(lon, lat, 100.0)
        rows = evaluate(lat, lon, float(e), D, crat, ice, None, crit)
        sc = score(rows)
        out.append({"id": pid, "lon": lon, "lat": lat, "elev_m": None if not math.isfinite(e) else round(float(e)),
                    "rows": [{k: r[k] for k in ("id", "status", "value")} for r in rows], **sc,
                    "ti": (D.get("ti") or {}).get("value") if D.get("ti") else None,
                    "ice_km": ice.get("dist_km") if ice and ice.get("found") else None})
    return out
