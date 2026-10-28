"""Whole-planet science and exploration features, shipped with the app (planet/data/features.json.gz, built by
tools/build_features.py from NASA Mars Trek and the NASA/JPL rover feeds): aqueous minerals, CRISM / OMEGA hydrous
detections, chloride salts, present-day activity (new impacts, recurring slope lineae, active gullies, icy impacts),
gullies, glaciers, alluvial fans, dune fields, valley networks, landers and rover traverses.

Used three ways:
  overlay_rgba()   drawn onto imagery tiles like the crater rims (planet/imagery.py)
  context()        what is near a place: per layer, how many features within a radius and the nearest one, for the
                   site dossier ("science along the way") and the science-objective finder
  in_radius()      the features themselves near a place (the Science tab lists them and flies to them)
Everything is read from the bundled file: no download, and it works in Mars mode."""
from __future__ import annotations

import gzip
import json
import math
import threading
from pathlib import Path

import numpy as np

from .config import R_MARS

_FILE = Path(__file__).parent / "data" / "features.json.gz"
_lock = threading.Lock()
_db: dict = {}

# drawing order on a tile: outlines and lines first, points on top, then the traverses and landers
ORDER = ("dunes", "chlorides", "valleys", "fans", "glacial", "gullies", "hydrous", "aqueous", "active", "traverses", "landers")
OVERLAY_IDS = {f"f_{k}" for k in ORDER}


def _load() -> dict:
    with _lock:
        if _db:
            return _db
        doc = {"layers": {}}
        from .config import PATHS
        # the install folder first (the packaged app runs these modules from its runtime folder), then next to this file
        for f in (PATHS.get("root", Path(".")) / "planet" / "data" / "features.json.gz", _FILE):
            try:
                doc = json.loads(gzip.decompress(f.read_bytes()))
                break
            except (OSError, ValueError):
                continue
        for k, L in doc.get("layers", {}).items():
            if L.get("pts") is not None and L["geom"] in ("point",):
                a = np.array(L["pts"], np.float64).reshape(-1, 3)
                L["_lon"], L["_lat"], L["_cls"] = a[:, 0], a[:, 1], a[:, 2].astype(np.int16)
            elif L.get("geom") == "named":
                L["_lon"] = np.array([p[0] for p in L["pts"]], np.float64)
                L["_lat"] = np.array([p[1] for p in L["pts"]], np.float64)
            elif L.get("geom") == "polygon":
                L["_lon"] = np.array([it["c"][0] for it in L["items"]], np.float64)
                L["_lat"] = np.array([it["c"][1] for it in L["items"]], np.float64)
                L["_bb"] = np.array([[min(p[0] for p in it["r"][0]), min(p[1] for p in it["r"][0]),
                                      max(p[0] for p in it["r"][0]), max(p[1] for p in it["r"][0])] for it in L["items"]], np.float64)
            elif L.get("geom") == "line":
                L["_bb"] = np.array([[min(p[0] for p in ln), min(p[1] for p in ln), max(p[0] for p in ln), max(p[1] for p in ln)]
                                     for ln in L["lines"]], np.float64)
                L["_lon"] = (L["_bb"][:, 0] + L["_bb"][:, 2]) / 2
                L["_lat"] = (L["_bb"][:, 1] + L["_bb"][:, 3]) / 2
            elif L.get("geom") == "track":
                for it in L["items"]:
                    p = np.array(it["path"], np.float64)
                    it["_bb"] = [p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max()]
        _db.update(doc)
        return _db


def available() -> bool:
    return bool(_load().get("layers"))


def layers() -> dict:
    return _load().get("layers", {})


def summary() -> dict:
    """The catalogue for the app: id -> name, group, what, citation, classes and counts (no geometry)."""
    out = {}
    for k, L in layers().items():
        n = len(L.get("pts") or L.get("items") or L.get("lines") or [])
        out[k] = {"name": L["name"], "group": L.get("group"), "what": L.get("what"), "cite": L.get("cite"), "src": L.get("src"),
                  "instruments": L.get("instruments"), "geom": L.get("geom"), "count": n,
                  "classes": [{"id": c["id"], "label": c["label"], "rgb": c["rgb"]} for c in L.get("classes", [])]}
    return {"built": _load().get("built"), "layers": out}


# ------------------------------------------------------------------ geometry

def _hav_km(lon0, lat0, lon, lat):
    p1, p2 = math.radians(lat0), np.radians(lat)
    dl = np.radians(np.asarray(lon) - lon0)
    h = np.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R_MARS / 1000 * np.arcsin(np.minimum(1, np.sqrt(h)))


def _seg_dist_km(lon0, lat0, path) -> float:
    """Shortest distance (km) from a point to a polyline, in a local flat frame (fine below a few hundred km)."""
    p = np.asarray(path, np.float64)
    k = math.cos(math.radians(lat0))
    # longitudes relative to the point, unwrapped along the line (a line near 180 E must not jump across the frame)
    rel = p[:, 0] - lon0
    steps = ((np.diff(rel) + 180) % 360) - 180
    x = ((((rel[0] + 180) % 360) - 180) + np.concatenate([[0.0], np.cumsum(steps)])) * k
    y = p[:, 1] - lat0
    if len(p) == 1:
        d = math.hypot(x[0], y[0])
    else:
        ax, ay, bx, by = x[:-1], y[:-1], x[1:], y[1:]
        vx, vy = bx - ax, by - ay
        L2 = np.maximum(vx * vx + vy * vy, 1e-18)
        t = np.clip(-(ax * vx + ay * vy) / L2, 0, 1)
        d = float(np.min(np.hypot(ax + t * vx, ay + t * vy)))
    return d * math.pi / 180 * R_MARS / 1000


def _label(L, i) -> str:
    if L["geom"] == "named":
        m, n = L["pts"][i][2], L["pts"][i][3]
        return f"{m}: {n}" if n else m
    cls = L.get("classes") or []
    if L["geom"] == "point" and cls:
        return cls[min(int(L["_cls"][i]), len(cls) - 1)]["label"]
    if L["geom"] == "polygon":
        a = L["items"][i].get("a")
        return f"{cls[0]['label']}" + (f" (type {a})" if a else "") if cls else L["name"]
    return cls[0]["label"] if cls else L["name"]


def in_radius(lon: float, lat: float, radius_km: float, layer_ids=None, limit: int = 40) -> list:
    """Features within radius_km of a point, nearest first: [{layer, label, lon, lat, km}]."""
    out = []
    for k, L in layers().items():
        if layer_ids and k not in layer_ids:
            continue
        if L["geom"] == "track":
            for it in L["items"]:
                d = _seg_dist_km(lon, lat, it["path"])
                if d <= radius_km:
                    out.append({"layer": k, "label": f"{it['name']} traverse", "lon": None, "lat": None, "km": round(d, 2)})
            continue
        if "_lon" not in L:
            continue
        dlat = radius_km / (R_MARS / 1000) * 180 / math.pi
        if L["geom"] in ("polygon", "line"):              # outlines and lines: their box must come within the radius
            dlon = min(180.0, dlat / max(0.02, math.cos(math.radians(min(89.0, abs(lat) + dlat)))))
            bb = L["_bb"]
            dx = np.abs(((np.clip(lon, bb[:, 0], bb[:, 2]) - lon + 180) % 360) - 180)
            m = (bb[:, 1] - dlat <= lat) & (lat <= bb[:, 3] + dlat) & (dx <= dlon)
        else:
            m = np.abs(L["_lat"] - lat) <= dlat
        idx = np.where(m)[0]
        if not idx.size:
            continue
        if L["geom"] == "line":
            d = np.array([_seg_dist_km(lon, lat, L["lines"][i]) for i in idx])
        elif L["geom"] == "polygon":
            d = np.array([0.0 if _inside(L["items"][i]["r"][0], lon, lat) else _seg_dist_km(lon, lat, L["items"][i]["r"][0]) for i in idx])
        else:
            d = _hav_km(lon, lat, L["_lon"][idx], L["_lat"][idx])
        for i, dd in zip(idx[d <= radius_km], d[d <= radius_km]):
            out.append({"layer": k, "label": _label(L, int(i)), "lon": float(L["_lon"][i]), "lat": float(L["_lat"][i]), "km": round(float(dd), 2)})
    out.sort(key=lambda r: r["km"])
    return out[:limit]


def _inside(ring, x, y) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            inside = not inside
    return inside


def context(lon: float, lat: float, radius_km: float = 100.0) -> dict:
    """Per layer: count within radius_km, the nearest feature and its distance, and the counts per class. The
    planetary-protection note flags candidate Special Regions (recurring slope lineae) near the place."""
    near = in_radius(lon, lat, radius_km, limit=100000)
    per = {}
    for r in near:
        p = per.setdefault(r["layer"], {"count": 0, "nearest": None, "classes": {}})
        p["count"] += 1
        p["classes"][r["label"]] = p["classes"].get(r["label"], 0) + 1
        if p["nearest"] is None:
            p["nearest"] = r
    for k, p in per.items():
        p["name"] = layers()[k]["name"]
        p["cite"] = layers()[k].get("cite")
    rsl = [r for r in in_radius(lon, lat, 300.0, {"active"}, limit=2000) if "slope lineae" in r["label"]]
    pp = None
    if rsl:
        pp = {"nearest_rsl_km": rsl[0]["km"], "label": rsl[0]["label"],
              "note": "Recurring slope lineae are candidate Special Regions (COSPAR planetary protection): crews keep out of "
                      "them unless a planetary-protection review allows it."}
    return {"radius_km": radius_km, "layers": per, "planetary_protection": pp}


# ------------------------------------------------------------------ drawing on imagery tiles

def overlay_rgba(ovl: str, w: float, s: float, e: float, n: float, size: int = 256):
    """(size, size, 4) float RGBA of one feature layer over the box (w, s, e, n), or None for an unknown id."""
    k = ovl[2:] if ovl.startswith("f_") else ovl
    L = layers().get(k)
    if L is None:
        return None
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    sx = size / (e - w)
    sy = size / (n - s)
    deg = e - w
    zoomish = max(0.0, math.log2(180.0 / max(deg, 1e-9)))     # 0 at a hemisphere tile, ~8 at a 0.7 deg tile

    def px(lo, la):
        lo = np.where(lo < w - 180, lo + 360, np.where(lo > e + 180, lo - 360, lo))
        return (lo - w) * sx, (n - la) * sy

    pad = 0.02 * deg + 0.05
    cls = L.get("classes") or [{"rgb": [255, 255, 255]}]
    if L["geom"] in ("point", "named"):
        lo, la = L["_lon"], L["_lat"]
        lo2 = np.where(lo < w - 180, lo + 360, np.where(lo > e + 180, lo - 360, lo))
        m = (lo2 >= w - pad) & (lo2 <= e + pad) & (la >= s - pad) & (la <= n + pad)
        idx = np.where(m)[0]
        r = 1.6 + 0.55 * zoomish if L["geom"] == "point" else 3.0 + 0.6 * zoomish
        r = min(r, 9.0)
        X, Y = px(lo[idx], la[idx])
        for j, x, y in zip(idx, X, Y):
            if L["geom"] == "named":
                dr.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 235), outline=(20, 20, 20, 255), width=2)
                continue
            c = cls[min(int(L["_cls"][j]), len(cls) - 1)]["rgb"]
            dr.ellipse([x - r, y - r, x + r, y + r], fill=(c[0], c[1], c[2], 215), outline=(15, 15, 15, 200), width=1)
    elif L["geom"] == "polygon":
        bb = L["_bb"]
        m = (bb[:, 2] >= w - pad) & (bb[:, 0] <= e + pad) & (bb[:, 3] >= s - pad) & (bb[:, 1] <= n + pad)
        c = cls[0]["rgb"]
        for j in np.where(m)[0]:
            for ring in L["items"][j]["r"]:
                a = np.asarray(ring, np.float64)
                X, Y = px(a[:, 0], a[:, 1])
                pts = list(zip(X.tolist(), Y.tolist()))
                if len(pts) >= 3:
                    dr.polygon(pts, fill=(c[0], c[1], c[2], 90), outline=(c[0], c[1], c[2], 240))
    elif L["geom"] == "line":
        bb = L["_bb"]
        m = (bb[:, 2] >= w - pad) & (bb[:, 0] <= e + pad) & (bb[:, 3] >= s - pad) & (bb[:, 1] <= n + pad)
        c = cls[0]["rgb"]
        width = 1 if zoomish < 4 else 2
        for j in np.where(m)[0]:
            a = np.asarray(L["lines"][j], np.float64)
            X, Y = px(a[:, 0], a[:, 1])
            dr.line(list(zip(X.tolist(), Y.tolist())), fill=(c[0], c[1], c[2], 220), width=width)
    elif L["geom"] == "track":
        colours = {"Curiosity": (255, 120, 60), "Perseverance": (80, 200, 255), "Spirit": (255, 220, 90), "Opportunity": (170, 255, 120)}
        width = 2 if zoomish < 10 else 3
        for it in L["items"]:
            b = it["_bb"]
            if b[2] < w - pad or b[0] > e + pad or b[3] < s - pad or b[1] > n + pad:
                continue
            a = np.asarray(it["path"], np.float64)
            X, Y = px(a[:, 0], a[:, 1])
            c = colours.get(it["name"], (255, 255, 255))
            xy = list(zip(X.tolist(), Y.tolist()))
            dr.line(xy, fill=(10, 10, 10, 200), width=width + 2)
            dr.line(xy, fill=c + (255,), width=width)
    return np.asarray(im, np.float32) / 255.0


def legend(ovl: str) -> dict | None:
    k = ovl[2:] if ovl.startswith("f_") else ovl
    L = layers().get(k)
    if L is None:
        return None
    if L["geom"] == "track":
        classes = [{"label": nm, "rgba": list(c) + [1.0]} for nm, c in
                   (("Curiosity", (255, 120, 60)), ("Perseverance", (80, 200, 255)), ("Spirit", (255, 220, 90)), ("Opportunity", (170, 255, 120)))]
    elif L["geom"] == "named":
        classes = [{"label": "Lander, rover or a named stop", "rgba": [255, 255, 255, 1.0]}]
    else:
        classes = [{"label": c["label"], "rgba": c["rgb"] + [0.85]} for c in L.get("classes", [])]
    n = len(L.get("pts") or L.get("items") or L.get("lines") or [])
    return {"title": f"{L['name']} ({n:,})", "classes": classes, "note": f"{L.get('what', '')}. {L.get('cite', '')}".strip()}
