"""Missions and science objectives: the catalogue of past, present and future Mars missions (planet/data/missions.json)
and the science-objective finder (planet/data/objectives.json).

An objective scores a place from the evidence near it: for each (feature layer, class, weight) it adds
weight * log2(1 + number of matching features within 100 km), plus optional terms from the installed global layers
(ice consistency, GRS water, gravity, cosmic-ray dose, sunlight, dust). rank() scores every candidate landing site and
built hub, so a crew can ask "where on Mars is best for this objective?" and then open the full landing dossier."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

_DIR = Path(__file__).parent / "data"
_cache: dict = {}


def _json(name: str) -> dict:
    if name not in _cache:
        from .config import PATHS
        _cache[name] = {}
        # the install folder first (the packaged app runs these modules from its runtime folder), then next to this file
        for d in (PATHS.get("root", Path(".")) / "planet" / "data", _DIR):
            try:
                _cache[name] = json.loads((d / name).read_text(encoding="utf-8"))
                break
            except (OSError, ValueError):
                continue
    return _cache[name]


def missions() -> dict:
    return _json("missions.json")


def objectives() -> dict:
    return _json("objectives.json")


def objective(oid: str) -> dict | None:
    return next((o for o in objectives().get("objectives", []) if o["id"] == oid), None)


def _data_terms(terms, lon, lat, elev_m) -> tuple[float, list]:
    pts, why = 0.0, []
    if not terms:
        return pts, why
    from . import atlas, datasets
    D = datasets.point(lon, lat)
    for key, w in terms:
        v = None
        if key == "ice" and D.get("ice"):
            vals = [x for x in (D["ice"].get("0-1 m"), D["ice"].get("1-5 m")) if x is not None]
            if vals:
                v = max(0.0, max(vals)) * 4
                why.append(f"shallow-ice consistency {max(vals):+.2f}")
        elif key == "grs_h2o" and D.get("grs_h2o_wt") is not None:
            v = D["grs_h2o_wt"]
            why.append(f"GRS water {v:.0f} wt %")
        elif key == "gravity_abs" and D.get("gravity_mgal") is not None:
            v = abs(D["gravity_mgal"])
            why.append(f"gravity anomaly {D['gravity_mgal']:+.0f} mGal")
        elif key in ("gcr_low", "sun") and elev_m is not None:
            m = atlas.point(lon, lat, elev_m)
            if key == "gcr_low" and "gcr_vs_gale" not in m:
                continue                                          # no usable elevation yet (MOLA not downloaded): skip the term
            if key == "gcr_low":
                v = max(0.0, (1.15 - m["gcr_vs_gale"]) * 10)          # less dose than 15 % above Gale's scores
                why.append(f"cosmic-ray dose {m['gcr_ugy_day']:.0f} uGy/day (model)")
            else:
                v = max(0.0, (m["sunlight_wm2"] - 60) / 15)
                why.append(f"sunlight {m['sunlight_wm2']:.0f} W/m2")
        elif key == "dust_penalty" and D.get("ti") and D["ti"].get("value") is not None:
            v = -2.0 if D["ti"]["value"] < 100 else 0.0
            if v:
                why.append("thick dust (thermal inertia below 100)")
        if v is not None:
            pts += w * v
    return pts, why


def evaluate(oid: str, lon: float, lat: float, elev_m: float | None = None, radius_km: float = 100.0, use_data: bool = True) -> dict:
    """Score one place for one objective, with the evidence listed."""
    from . import features
    o = objective(oid)
    if o is None:
        raise ValueError(f"unknown objective {oid}")
    layer_ids = {e[0] for e in o.get("evidence", [])}
    near = features.in_radius(lon, lat, radius_km, layer_ids or {"__none__"}, limit=100000) if layer_ids else []
    score, ev = 0.0, []
    for layer, cls, w in o.get("evidence", []):
        hits = [r for r in near if r["layer"] == layer and (cls == "*" or cls.lower() in r["label"].lower())]
        if hits:
            score += w * math.log2(1 + len(hits))
            ev.append({"layer": layer, "class": cls, "count": len(hits), "nearest_km": hits[0]["km"], "label": hits[0]["label"]})
    dp, why = _data_terms(o.get("data_terms", []), lon, lat, elev_m) if use_data else (0.0, [])
    score += dp
    return {"objective": oid, "lon": lon, "lat": lat, "score": round(score, 2), "evidence": ev, "data": why}


def rank(oid: str, points: list, radius_km: float = 100.0) -> list:
    """Score a list of [lon, lat, id, name] places for an objective, best first."""
    from . import megdr
    lons = np.array([p[0] for p in points], np.float64)
    lats = np.array([p[1] for p in points], np.float64)
    try:
        el = megdr.sample16(lons, lats)
    except Exception:  # noqa: BLE001 - MOLA base not downloaded yet: data terms that need elevation are skipped
        el = np.full(len(points), np.nan)
    out = []
    for p, e in zip(points, el):
        r = evaluate(oid, float(p[0]), float(p[1]), float(e) if np.isfinite(e) else None, radius_km)
        r.update(id=p[2] if len(p) > 2 else "", name=p[3] if len(p) > 3 else "")
        out.append(r)
    out.sort(key=lambda r: -r["score"])
    return out


# ---------------------------------------------------------------------------------------------- materials filter
# What a crew might need a site to have nearby, as matches in the bundled catalogues (planet/features.py). Each entry:
# (id, label, group, feature layer, class text to match in the feature's label, "*" = any).
MATERIALS = [
    ("clays", "Clays (phyllosilicates)", "Water-formed minerals", "aqueous", "Phyllosilicates"),
    ("sulfates", "Sulfates", "Water-formed minerals", "aqueous", "Sulfates"),
    ("silica", "Hydrated silica", "Water-formed minerals", "aqueous", "Hydrated silica"),
    ("carbonates", "Carbonates", "Water-formed minerals", "aqueous", "Carbonates"),
    ("chlorides", "Chloride salts", "Water-formed minerals", "chlorides", "*"),
    ("hydrous", "Hydrated minerals (CRISM / OMEGA)", "Water-formed minerals", "hydrous", "*"),
    ("glacier", "Buried glacier ice", "Ice", "glacial", "Glacier-like form"),
    ("newice", "Fresh craters that exposed ice", "Ice", "active", "exposed ice"),
    ("gullies", "Gullies", "Ice", "gullies", "*"),
    ("rsl", "Recurring slope lineae", "Mars today", "active", "Recurring slope lineae"),
    ("newcrater", "New impact craters (since 1999)", "Mars today", "active", "New impact crater"),
    ("rivers", "Ancient river valleys", "Ancient water", "valleys", "*"),
    ("fans", "Alluvial fans", "Ancient water", "fans", "*"),
    ("dunes", "Dune fields (soft ground)", "Hazards", "dunes", "*"),
]


def materials_near(lon: float, lat: float, radius_km: float = 100.0) -> dict:
    """Count and nearest distance of every MATERIALS entry within radius_km: {id: [count, nearest_km]}."""
    from . import features
    layers = {m[3] for m in MATERIALS}
    near = features.in_radius(lon, lat, radius_km, layers, limit=1_000_000)
    out = {}
    for mid, _label, _group, layer, cls in MATERIALS:
        hits = [r for r in near if r["layer"] == layer and (cls == "*" or cls.lower() in r["label"].lower())]
        if hits:
            out[mid] = [len(hits), hits[0]["km"]]
    return out


_mat_cache: dict = {}


def materials_for_sites(points: list, radius_km: float = 100.0) -> dict:
    """materials_near() for a list of [lon, lat, id, name] places, cached per radius (the catalogues never change)."""
    key = (round(radius_km), tuple(p[2] for p in points))
    if key not in _mat_cache:
        _mat_cache[key] = {p[2]: materials_near(float(p[0]), float(p[1]), radius_km) for p in points}
    return {"radius_km": radius_km, "materials": [{"id": m[0], "label": m[1], "group": m[2]} for m in MATERIALS],
            "sites": _mat_cache[key]}


def site_science(targets: list, radius_km: float = 30.0) -> dict:
    """Science around each stop of a built site, for the planner (written next to the site's manifest as science.json):
    the materials within radius_km with the nearest distance, and the objectives the stop serves best."""
    defs = {o["id"]: o for o in objectives().get("objectives", [])}
    out = {"radius_km": radius_km, "materials": [{"id": m[0], "label": m[1], "group": m[2]} for m in MATERIALS], "stops": {}}
    for t in targets:
        if t.get("kind") == "base":
            continue
        lon, lat = float(t["lon"]), float(t["lat"])
        objs = []
        for oid in defs:
            # catalogued evidence only: the global data layers (3 km and coarser) cannot tell stops a few km apart
            r = evaluate(oid, lon, lat, None, radius_km, use_data=False)
            if r["score"] > 0:
                objs.append({"id": oid, "title": defs[oid]["title"], "score": r["score"], "at_stations": defs[oid].get("at_stations", ""),
                             "evidence": r["evidence"][:4]})
        objs.sort(key=lambda o: -o["score"])
        out["stops"][t["id"]] = {"materials": materials_near(lon, lat, radius_km), "objectives": objs[:3]}
    return out


def write_site_science(site_dir) -> dict | None:
    """Build science.json for the site in site_dir (a folder with manifest.json). Returns the dict, or None."""
    site_dir = Path(site_dir)
    try:
        man = json.loads((site_dir / "manifest.json").read_text())
    except (OSError, ValueError):
        return None
    sc = site_science(man.get("targets", []))
    sc["site"] = man.get("site_info", {}).get("name") or man.get("site")
    (site_dir / "science.json").write_text(json.dumps(sc, separators=(",", ":")))
    return sc

