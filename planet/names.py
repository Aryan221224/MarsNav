"""IAU Gazetteer of Planetary Nomenclature for Mars (USGS): every officially named feature, for search ("go to Gale")
and for naming new sites. Source: https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.kmz
(generated nightly by USGS). Cached on disk; a small built-in list keeps search working before the first download."""
from __future__ import annotations

import io
import json
import math
import re
import threading
import time
import zipfile
from xml.etree import ElementTree as ET

from . import net
from .config import PATHS

KMZ = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.kmz"
CITATION = "Gazetteer of Planetary Nomenclature, IAU WGPSN / USGS Astrogeology (planetarynames.wr.usgs.gov)"
# a few well-known places (IAU coordinates, planetocentric east) so the globe is usable before the download finishes
SEED = [
    ("Jezero", "Crater", 77.58, 18.38, 45.0), ("Gale", "Crater", 137.81, -5.37, 154.0), ("Olympus Mons", "Mons", -134.0, 18.65, 624.0),
    ("Valles Marineris", "Chasma", -59.2, -13.9, 4000.0), ("Hellas Planitia", "Planitia", 70.5, -42.4, 2300.0),
    ("Elysium Planitia", "Planitia", 154.7, 2.99, 3000.0), ("Arsia Mons", "Mons", -120.46, -8.26, 435.0),
    ("Utopia Planitia", "Planitia", 117.5, 46.7, 3300.0), ("Meridiani Planum", "Planum", -3.8, 0.2, 1100.0),
    ("Gusev", "Crater", 175.4, -14.5, 166.0), ("Holden", "Crater", -33.9, -26.4, 154.0), ("Mawrth Vallis", "Vallis", -16.0, 22.6, 636.0),
    ("Arcadia Planitia", "Planitia", -168.0, 46.7, 1500.0), ("Planum Boreum", "Planum", 0.0, 88.0, 1000.0),
]
_lock = threading.Lock()
_feats: list | None = None
_status = {"source": "built-in", "count": len(SEED)}


def _parse_kmz(blob: bytes) -> list:
    z = zipfile.ZipFile(io.BytesIO(blob))
    kml = next(n for n in z.namelist() if n.lower().endswith(".kml"))
    root = ET.fromstring(z.read(kml))
    ns = {"k": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    q = (lambda t: f"k:{t}") if ns else (lambda t: t)
    out = []
    for pm in root.iter(("{%s}" % ns["k"] if ns else "") + "Placemark"):
        name = (pm.findtext(q("name"), default="", namespaces=ns) or "").strip()
        coords = pm.find(f".//{q('coordinates')}", ns)
        if not name or coords is None or not coords.text:
            continue
        try:
            lon, lat = [float(v) for v in coords.text.strip().split(",")[:2]]
        except ValueError:
            continue
        desc = pm.findtext(q("description"), default="", namespaces=ns) or ""
        # extended data (newer files) or the description table (older files)
        data = {d.get("name"): (d.findtext(q("value"), default="", namespaces=ns) or "") for d in pm.iter(("{%s}" % ns["k"] if ns else "") + "Data")}
        sd = {s.get("name"): (s.text or "") for s in pm.iter(("{%s}" % ns["k"] if ns else "") + "SimpleData")}
        data.update(sd)
        ftype = data.get("type") or data.get("Feature_Type") or data.get("feature_type") or ""
        diam = data.get("diameter") or data.get("Diameter") or ""
        if not ftype:
            m = re.search(r"Feature Type[^<]*</[^>]+>\s*<[^>]+>([^<]+)", desc) or re.search(r"type[^:]*:\s*([A-Za-z ,]+)", desc, re.I)
            ftype = m.group(1).strip() if m else ""
        if not diam:
            m = re.search(r"Diameter[^<]*</[^>]+>\s*<[^>]+>([\d.]+)", desc) or re.search(r"diameter[^:]*:\s*([\d.]+)", desc, re.I)
            diam = m.group(1) if m else ""
        if lon > 180:
            lon -= 360
        try:
            d = float(diam)
        except ValueError:
            d = 0.0
        out.append([name, ftype.split(",")[0].strip(), round(lon, 5), round(lat, 5), d])
    return out


def load(refresh_days: float = 30) -> list:
    global _feats
    with _lock:
        if _feats is not None:
            return _feats
    path = PATHS["catalog"] / "iau_mars.json"
    cached = None
    if path.exists():
        try:
            cached = json.loads(path.read_text())
        except (OSError, ValueError):
            cached = None
    feats = cached["features"] if cached else None
    if not cached or (time.time() - cached.get("t", 0) > refresh_days * 86400 and not net.blocked()):
        try:
            got = _parse_kmz(net.get(KMZ, timeout=60))
            if len(got) > 100:
                feats = got
                path.write_text(json.dumps({"t": time.time(), "features": feats}))
        except Exception as e:  # noqa: BLE001
            _status["error"] = f"{type(e).__name__}: {e}"
    if not feats:
        feats = [list(s) for s in SEED]
        _status["source"] = "built-in"
    else:
        _status["source"] = "IAU/USGS gazetteer"
    _status["count"] = len(feats)
    with _lock:
        _feats = feats
    return feats


def search(q: str, limit: int = 20) -> list:
    q = q.strip().lower()
    if not q:
        return []
    feats = load()
    scored = []
    for f in feats:
        nm = f[0].lower()
        if nm == q:
            sc = 0
        elif nm.startswith(q):
            sc = 1
        elif q in nm:
            sc = 2
        else:
            continue
        scored.append((sc, -f[4], f))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [{"name": f[0], "type": f[1], "lon": f[2], "lat": f[3], "diameter_km": f[4]} for _a, _b, f in scored[:limit]]


def nearest(lon: float, lat: float, k: int = 5, max_km: float = 1e9) -> list:
    out = []
    p1 = math.radians(lat)
    for f in load():
        p2 = math.radians(f[3])
        dl = math.radians(f[2] - lon)
        c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
        dkm = 3396.19 * math.acos(max(-1.0, min(1.0, c)))
        if dkm <= max_km:
            out.append((dkm, f))
    out.sort(key=lambda t: t[0])
    return [{"name": f[0], "type": f[1], "lon": f[2], "lat": f[3], "diameter_km": f[4], "dist_km": round(d, 2)} for d, f in out[:k]]


def inside(w: float, s: float, e: float, n: float) -> list:
    return [{"name": f[0], "type": f[1], "lon": f[2], "lat": f[3], "diameter_km": f[4]} for f in load()
            if w <= f[2] <= e and s <= f[3] <= n]


def status() -> dict:
    return dict(_status)
