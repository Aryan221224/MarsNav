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
        try:
            _cache[name] = json.loads((_DIR / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _cache[name] = {}
    return _cache[name]


def missions() -> dict:
    return _json("missions.json")


def objectives() -> dict:
    return _json("objectives.json")


def objective(oid: str) -> dict | None:
    return next((o for o in objectives().get("objectives", []) if o["id"] == oid), None)


def _data_terms(terms, lon, lat, elev_m) -> tuple[float, list]:
    from . import atlas, datasets
    pts, why = 0.0, []
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


def evaluate(oid: str, lon: float, lat: float, elev_m: float | None = None, radius_km: float = 100.0) -> dict:
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
    dp, why = _data_terms(o.get("data_terms", []), lon, lat, elev_m)
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
