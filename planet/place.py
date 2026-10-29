"""Everything known about one place on Mars, for any point a crew or planner selects: where it is (chart quadrangle,
names), the ground (thermal inertia, dust, albedo, roughness, geology, craters), water (SWIM ice at three depths, the
nearest ice, GRS hydrogen), composition (TES minerals, GRS elements), environment (pressure, liquid-water window, gravity,
cosmic-ray dose, sunlight), science (catalogued features, objective scores), missions and candidate sites nearby, the
best elevation and image data covering it, built sites it falls in, the landing quick screen and space weather.

Everything here is read from data on this computer (or its caches) in well under a second, except two remote lookups
that run in parallel with a time budget: the geologic map unit (USGS OGC API) and the Trek colour maps (one 0.35 deg tile
each, cached after the first read). A lookup that has not answered in time is marked pending; the app asks again.
The landing ellipse and the metre-scale elevation stay with /api/assess and /api/point (they read elevation models)."""
from __future__ import annotations

import json
import math
from concurrent.futures import ThreadPoolExecutor, wait

import numpy as np

from .config import PATHS

GM = 42828.37e9          # m^3/s^2, Mars (Konopliv et al. 2016, MRO gravity)
J2 = 1.9566e-3           # unnormalised zonal coefficient
OMEGA = 7.088218e-5      # rad/s, rotation
A_EQ, B_POLE = 3396190.0, 3376200.0      # m, IAU Mars ellipsoid
G_EARTH = 9.80665
TRIPLE_PA = 611.657      # Pa, triple point of water
_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="place")


# ------------------------------------------------------------------ geography

# USGS 1:5M Mars Chart (MC) quadrangles: latitude band, then longitude ranges eastward from 180 W.
_MC = [
    (65, 90, [(-180, 180, 1, "Mare Boreum")]),
    (30, 65, [(-180, -120, 2, "Diacria"), (-120, -60, 3, "Arcadia"), (-60, 0, 4, "Mare Acidalium"), (0, 60, 5, "Ismenius Lacus"),
              (60, 120, 6, "Casius"), (120, 180, 7, "Cebrenia")]),
    (0, 30, [(-180, -135, 8, "Amazonis"), (-135, -90, 9, "Tharsis"), (-90, -45, 10, "Lunae Palus"), (-45, 0, 11, "Oxia Palus"),
             (0, 45, 12, "Arabia"), (45, 90, 13, "Syrtis Major"), (90, 135, 14, "Amenthes"), (135, 180, 15, "Elysium")]),
    (-30, 0, [(-180, -135, 16, "Memnonia"), (-135, -90, 17, "Phoenicis Lacus"), (-90, -45, 18, "Coprates"), (-45, 0, 19, "Margaritifer Sinus"),
              (0, 45, 20, "Sinus Sabaeus"), (45, 90, 21, "Iapygia"), (90, 135, 22, "Mare Tyrrhenum"), (135, 180, 23, "Aeolis")]),
    (-65, -30, [(-180, -120, 24, "Phaethontis"), (-120, -60, 25, "Thaumasia"), (-60, 0, 26, "Argyre"), (0, 60, 27, "Noachis"),
                (60, 120, 28, "Hellas"), (120, 180, 29, "Eridania")]),
    (-90, -65, [(-180, 180, 30, "Mare Australe")]),
]


def quadrangle(lon: float, lat: float) -> dict:
    """The USGS Mars Chart quadrangle (MC-1 to MC-30) a place is on."""
    lon = ((lon + 180.0) % 360.0) - 180.0
    for s, n, cols in _MC:
        if s <= lat <= n:
            for w, e, k, name in cols:
                if w <= lon < e or (e == 180 and lon == 180):
                    return {"id": f"MC-{k:02d}", "name": name}
    return {"id": "MC-30" if lat < 0 else "MC-01", "name": "Mare Australe" if lat < 0 else "Mare Boreum"}


def _hav_km(a_lon, a_lat, b_lon, b_lat):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lon - a_lon) / 2) ** 2
    return 2 * 3396.19 * math.asin(min(1.0, math.sqrt(h)))


def _bearing(a_lon, a_lat, b_lon, b_lat):
    p1, p2, dl = math.radians(a_lat), math.radians(b_lat), math.radians(b_lon - a_lon)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


# ------------------------------------------------------------------ physics at the surface

def gravity(lat: float, elev_m: float | None, anomaly_mgal: float | None = None) -> dict:
    """Surface gravity from Mars' mass, flattening (J2) and spin, at the ellipsoid plus the MOLA elevation, plus the
    measured free-air anomaly (MRO GMM-3) when installed. 1 mGal = 1e-5 m/s^2."""
    phi = math.radians(lat)
    r0 = A_EQ * B_POLE / math.hypot(B_POLE * math.cos(phi), A_EQ * math.sin(phi))
    r = r0 + (elev_m if elev_m is not None and math.isfinite(elev_m) else 0.0)
    p2 = 1.5 * math.sin(phi) ** 2 - 0.5
    g = GM / r ** 2 * (1 - 3 * J2 * (A_EQ / r) ** 2 * p2) - OMEGA ** 2 * r * math.cos(phi) ** 2
    if anomaly_mgal is not None and math.isfinite(anomaly_mgal):
        g += anomaly_mgal * 1e-5
    return {"g_ms2": round(g, 4), "earth_ratio": round(g / G_EARTH, 4), "with_anomaly": anomaly_mgal is not None,
            "note": "GM, J2 and spin of Mars at the ellipsoid plus elevation" + (", plus the measured anomaly" if anomaly_mgal is not None else "")}


def _psat_pa(t_c: float) -> float:
    """Saturation vapour pressure of water over liquid (Buck 1996), Pa."""
    return 611.21 * math.exp((18.678 - t_c / 234.5) * (t_c / (257.14 + t_c)))


def water_phase(pressure_pa: float | None) -> dict | None:
    """Can liquid water exist here at the mean pressure? Above the triple point it can, between melting (0 C) and boiling."""
    if pressure_pa is None or not math.isfinite(pressure_pa):
        return None
    if pressure_pa <= TRIPLE_PA:
        return {"liquid_possible": False, "pressure_pa": round(pressure_pa),
                "note": "Below water's triple point (611.7 Pa): ice turns straight to vapour; liquid water cannot persist."}
    lo, hi = 0.0, 100.0
    for _ in range(40):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if _psat_pa(mid) < pressure_pa else (lo, mid)
    return {"liquid_possible": True, "boil_c": round((lo + hi) / 2, 1), "pressure_pa": round(pressure_pa),
            "note": f"Above the triple point: pure liquid water is possible between 0 and {(lo + hi) / 2:.1f} C (it boils above), "
                    "though it still evaporates fast into the dry air. Brines stay liquid colder."}


# ------------------------------------------------------------------ what lies around

def missions_near(lon: float, lat: float, k: int = 5) -> list:
    """Landed (or targeted) missions of the catalogue by distance."""
    from . import science
    out = []
    for m in science.missions().get("missions", []):
        s = m.get("site") or {}
        if s.get("lon") is None or s.get("lat") is None:
            continue
        d = _hav_km(lon, lat, s["lon"], s["lat"])
        out.append({"id": m["id"], "name": m["name"], "agency": m.get("agency"), "status": m.get("status"), "years": m.get("years"),
                    "site": s.get("name"), "lon": s["lon"], "lat": s["lat"], "dist_km": round(d, 1),
                    "bearing_deg": round(_bearing(lon, lat, s["lon"], s["lat"]))})
    out.sort(key=lambda r: r["dist_km"])
    return out[:k]


def built_sites(lon: float, lat: float) -> dict:
    """Built EVA sites: the one this place is inside (if any) and the nearest hubs."""
    f = PATHS["app_data"] / "sites.json"
    inside, near = None, []
    try:
        sites = json.loads(f.read_text()) if f.exists() else []
    except (OSError, ValueError):
        sites = []
    for st in sites:
        try:
            cfg = json.loads((PATHS["pipeline"] / "sites" / f"{st['id']}.json").read_text())
            w, s, e, n = cfg["ops_area"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        c_lon, c_lat = (w + e) / 2, (s + n) / 2
        row = {"id": st["id"], "name": st.get("name") or st["id"], "short": st.get("short"), "lon": c_lon, "lat": c_lat,
               "dist_km": round(_hav_km(lon, lat, c_lon, c_lat), 1)}
        if w <= lon <= e and s <= lat <= n and inside is None:
            inside = row
        near.append(row)
    near.sort(key=lambda r: r["dist_km"])
    return {"inside": inside, "nearest": near[:3]}


def coverage_here(lon: float, lat: float) -> dict:
    """The detailed elevation models (and their orthoimages) whose footprint covers this point."""
    from . import catalog
    eps = 1e-4
    out = {}
    for kind in ("hirise", "ctx"):
        try:
            items = catalog.query(kind, lon - eps, lat - eps, lon + eps, lat + eps, limit=50)
        except Exception:  # noqa: BLE001 - catalogue not loaded yet
            items = []
        out[kind] = {"count": len(items), "items": [{"id": it["id"], "gsd_m": it.get("gsd"), "date": (it.get("date") or "")[:10],
                                                     "ortho": bool(it.get("ortho"))} for it in items[:6]],
                     "ready": catalog.ready(kind)}
    out["best_m"] = 1.0 if out["hirise"]["count"] else 20.0 if out["ctx"]["count"] else None
    return out


# ------------------------------------------------------------------ the whole picture

def everything(lon: float, lat: float, crit: str = "hls2", wait_s: float = 4.0) -> dict:
    """Every layer at one place. Slow remote parts run in parallel; whatever misses wait_s is returned as pending."""
    from . import assess, atlas, datasets, features, megdr, names, science, spaceweather
    lon = round(((float(lon) + 180.0) % 360.0) - 180.0, 6)
    lat = round(max(-90.0, min(90.0, float(lat))), 6)
    jobs = {"geology": _pool.submit(datasets.geology_at, lon, lat)}
    for k in atlas.TREK_OVL:
        jobs[k] = _pool.submit(atlas.sample_trek, k, lon, lat)

    try:
        e = float(megdr.sample128(np.array([lon]), np.array([lat]), allow_download=False)[0])
        e_src = "MOLA MEGDR 128 px/deg (463 m)"
    except Exception:  # noqa: BLE001 - the 128 px/deg tile is not on this computer
        e = float("nan")
    if not math.isfinite(e):
        try:
            e = float(megdr.sample16(np.array([lon]), np.array([lat]))[0])
            e_src = "MOLA MEGDR 16 px/deg (3.7 km)"
        except Exception:  # noqa: BLE001 - MOLA base not downloaded yet
            e, e_src = float("nan"), None
    elev = e if math.isfinite(e) else None

    D = datasets.point(lon, lat)
    out: dict = {"ok": True, "lon": lon, "lat": lat}
    try:
        nm = names.nearest(lon, lat, k=5)
    except Exception:  # noqa: BLE001
        nm = []
    out["where"] = {"lon_east": round(lon if lon >= 0 else lon + 360, 4), "lon_west": round((-lon) % 360, 4),
                    "quadrangle": quadrangle(lon, lat), "names": nm,
                    "hemisphere": ("northern" if lat >= 0 else "southern") + (" lowlands" if elev is not None and elev < -2500 else
                                                                               " highlands" if elev is not None and elev > 0 else "")}
    out["elevation"] = {"m": None if elev is None else round(elev), "source": e_src}
    env = assess.environment(lat, elev)
    model = atlas.point(lon, lat, elev)
    out["environment"] = {**env, **model, "water": water_phase(env["pressure_pa"] if elev is not None else None),
                          "gravity": gravity(lat, elev, D.get("gravity_mgal"))}
    out["surface"] = {"ti": D.get("ti"), "albedo": D.get("albedo"), "craters": datasets.craters_near(lon, lat, 10.0),
                      "craters_zone": datasets.craters_near(lon, lat, 100.0)}
    out["water"] = {"ice": D.get("ice"), "grs_h2o_wt": D.get("grs_h2o_wt"), "nearest_ice": datasets.ice_near(lon, lat, 100.0)}
    out["composition"] = {"chem": D.get("chem")}
    out["gravity_anomaly_mgal"] = D.get("gravity_mgal")
    out["installed"] = D.get("installed")
    if features.available():
        out["science"] = {"context": features.context(lon, lat, 100.0), "nearest": features.in_radius(lon, lat, 50.0, None, 12)}
    else:
        out["science"] = None
    try:
        objs = sorted((science.evaluate(o["id"], lon, lat, elev) for o in science.objectives().get("objectives", [])), key=lambda r: -r["score"])
        for r in objs:
            r["title"] = science.objective(r["objective"])["title"]
    except Exception as ex:  # noqa: BLE001 - a missing catalogue never breaks the place
        objs = [{"error": f"{type(ex).__name__}: {ex}"}]
    out["objectives"] = objs
    out["missions"] = missions_near(lon, lat)
    out["context"] = assess.context(lon, lat)
    out["sites"] = built_sites(lon, lat)
    out["coverage"] = coverage_here(lon, lat)
    try:
        out["screen"] = assess.screen([[lon, lat, "here"]], crit)[0]
    except Exception:  # noqa: BLE001
        out["screen"] = None
    try:
        sw = spaceweather.summary()
        out["spaceweather"] = {k: sw.get(k) for k in ("have_data", "level", "headline", "action", "geometry")}
    except Exception:  # noqa: BLE001
        out["spaceweather"] = None

    done, _ = wait(list(jobs.values()), timeout=wait_s)
    pending = [k for k, f in jobs.items() if f not in done]

    def res(k):
        f = jobs[k]
        if f not in done:
            return {"pending": True}
        try:
            return f.result()
        except Exception as ex:  # noqa: BLE001
            return {"error": type(ex).__name__}
    out["surface"]["geology"] = res("geology")
    out["surface"]["dust_cover"] = res("dci")
    out["surface"]["roughness"] = res("roughness")
    out["composition"]["minerals"] = {k: res(k) for k in ("tes_plag", "tes_cpx", "tes_glass")}
    out["pending"] = pending
    return out
