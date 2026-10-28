"""Build planet/data/features.json.gz: the whole-planet science and exploration feature catalogues that MarsNav ships
with, so every one of them works from the first start with no download (and in Mars mode).

Every layer is downloaded from its published source, simplified only where a line or outline has more vertices than a
globe can show, and written with its citation:

  NASA Mars Trek map services (trek.nasa.gov/mars/trekarcgis/rest/services, native Mars 2000 geographic coordinates)
    aqueous      Aqueous minerals: phyllosilicates, sulfates, silica, chlorides, carbonates (Ehlmann & Edwards 2014)
    hydrous      Hydrous mineral detections by CRISM and OMEGA (Carter et al. 2013)
    chlorides    Chloride salt-bearing deposits from THEMIS (Osterloo et al. 2010)
    active       New impact craters (Daubar et al. 2013), recurring slope lineae (McEwen et al. 2014, Ojha et al. 2014),
                 active and dune gullies (Dundas et al. 2015), icy impact sites (Dundas et al. 2014)
    gullies      Every gully site found in CTX (Harrison et al. 2015)
    glf          Glacier-like forms (Souness et al. 2012) and recessional GLFs (Brough et al. 2016)
    glacial      Supraglacial and proglacial valleys (Fassett et al. 2010)
    fans         Large alluvial fans (Moore & Howard 2005; Kraal et al. 2008)
    dunes        Mars Global Digital Dune Database (Hayward et al. 2007, USGS OFR 2007-1158)
    valleys      Valley networks (Hynek et al. 2010)
    landers      Lander, rover and hardware positions (Viking 1/2, Pathfinder, Spirit, Opportunity, Phoenix, InSight)
  NASA/JPL rover waypoint feeds (mars.nasa.gov/mmgis-maps)
    traverses    Curiosity (MSL) and Perseverance (Mars 2020) to their latest sol, Spirit and Opportunity from Mars Trek

Run:  python tools/build_features.py            (about 2 minutes; writes planet/data/features.json.gz)
      python tools/build_features.py --cache D  (keep the raw downloads in D and reuse them)"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "planet" / "data" / "features.json.gz"
TREK = "https://trek.nasa.gov/mars/trekarcgis/rest/services"
FEEDS = {"msl": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json",
         "m2020": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"}
UA = {"User-Agent": "MarsNav build_features (NASA Space Apps 2026; github.com/Aryan221224/MarsNav)"}


def get_json(url: str, timeout: float = 180):
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                j = json.load(r)
            if isinstance(j, dict) and "error" in j:
                raise RuntimeError(f"{url[:100]}: {j['error']}")
            return j
        except (OSError, TimeoutError) as e:
            if attempt == 3:
                raise
            print(f"  retry ({e})")
            time.sleep(5 * (attempt + 1))


def trek_layer(service: str, layer: int, cache: Path | None):
    """Every feature of one Mars Trek map-service layer (the services do not page: read in object-id ranges)."""
    if cache:
        f = cache / f"{service}_{layer}.json"
        if f.exists():
            return json.loads(f.read_text())
    base = f"{TREK}/{service}/MapServer/{layer}/query?"
    ids = get_json(base + urllib.parse.urlencode({"where": "1=1", "returnIdsOnly": "true", "f": "json"}))
    oid = ids.get("objectIdFieldName", "FID")
    ids = sorted(ids.get("objectIds") or [])
    feats = []
    a = ids[0] if ids else 0
    while ids and a <= ids[-1]:
        q = {"where": f"{oid}>={a} AND {oid}<{a + 500}", "outFields": "*", "returnGeometry": "true", "f": "json"}
        feats += get_json(base + urllib.parse.urlencode(q)).get("features", [])
        a += 500
    if len(feats) != len(ids):
        raise RuntimeError(f"{service}/{layer}: {len(feats)} of {len(ids)} features read")
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / f"{service}_{layer}.json").write_text(json.dumps(feats))
    print(f"  {service}/{layer}: {len(feats)} features")
    return feats


def r4(v: float) -> float:
    return round(float(v), 4)


def lon180(lon: float) -> float:
    return ((float(lon) + 180.0) % 360.0) - 180.0


def dp(pts: list, tol: float) -> list:
    """Douglas-Peucker simplification of [[lon, lat], ...] with a tolerance in degrees. A closed ring (first point = last)
    is split at the vertex farthest from its start, so the two halves have distinct end points."""
    if len(pts) < 3:
        return pts
    if pts[0] == pts[-1] and len(pts) > 4:
        x0, y0 = pts[0]
        k = max(range(1, len(pts) - 1), key=lambda m: (pts[m][0] - x0) ** 2 + (pts[m][1] - y0) ** 2)
        return dp(pts[:k + 1], tol)[:-1] + dp(pts[k:], tol)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x0, y0), (x1, y1) = pts[i], pts[j]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1e-12
        best, k = -1.0, -1
        for m in range(i + 1, j):
            x, y = pts[m]
            d = abs(dy * (x - x0) - dx * (y - y0)) / L
            if d > best:
                best, k = d, m
        if best > tol:
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [p for p, kp in zip(pts, keep) if kp]


def points(feats, cls_of=lambda a: 0):
    out = []
    for f in feats:
        g = f.get("geometry") or {}
        if "x" not in g:
            continue
        out.append([r4(lon180(g["x"])), r4(g["y"]), cls_of(f["attributes"])])
    return out


def polygons(feats, tol: float, attr=lambda a: None, min_pts: int = 4):
    out = []
    for f in feats:
        rings = []
        for ring in (f.get("geometry") or {}).get("rings", []):
            full = [[r4(lon180(x)), r4(y)] for x, y in ring]
            rr = dp(full, tol)
            if len(rr) < min_pts:
                rr = full                          # a deposit smaller than the tolerance keeps its outline
            if len(rr) >= min_pts:
                rings.append(rr)
        if not rings:
            continue
        xs = [p[0] for p in rings[0]]
        ys = [p[1] for p in rings[0]]
        item = {"c": [r4(sum(xs) / len(xs)), r4(sum(ys) / len(ys))], "r": rings}
        a = attr(f["attributes"])
        if a is not None:
            item["a"] = a
        out.append(item)
    return out


def lines(feats, tol: float, min_pts: int = 2):
    out = []
    for f in feats:
        for path in (f.get("geometry") or {}).get("paths", []):
            pp = dp([[r4(lon180(x)), r4(y)] for x, y in path], tol)
            if len(pp) >= min_pts:
                out.append(pp)
    return out


def cls_index(classes: list):
    ids = [c["id"] for c in classes]
    return lambda v: ids.index(v) if v in ids else len(ids) - 1


def feed_track(url: str, tol: float = 0.00015):
    j = get_json(url)
    pts = [[r4(p["properties"]["lon"]), r4(p["properties"]["lat"])] for p in j["features"]
           if p.get("properties", {}).get("lon") is not None]
    sols = [p["properties"]["sol"] for p in j["features"]]
    return dp(pts, tol), (min(sols), max(sols)), len(pts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, default=None, help="keep and reuse the raw downloads here")
    args = ap.parse_args()
    C = args.cache
    L = {}

    aq_cls = [{"id": "phyllosilicate", "label": "Phyllosilicates (clays)", "rgb": [70, 140, 255]},
              {"id": "sulfate", "label": "Sulfates", "rgb": [255, 150, 40]},
              {"id": "silica", "label": "Hydrated silica", "rgb": [190, 110, 255]},
              {"id": "chloride", "label": "Chlorides", "rgb": [255, 230, 60]},
              {"id": "carbonate", "label": "Carbonates", "rgb": [60, 220, 120]}]
    ci = cls_index(aq_cls)
    L["aqueous"] = {"name": "Aqueous minerals", "group": "spectral", "geom": "point", "classes": aq_cls,
                    "what": "Where orbiters found minerals that form in water: clays, sulfates, silica, chlorides, carbonates",
                    "instruments": "MRO CRISM, Mars Express OMEGA, Mars Odyssey THEMIS",
                    "cite": "Ehlmann B.L. & Edwards C.S. 2014, Mineralogy of the Martian surface, Annu. Rev. Earth Planet. Sci. 42, 291",
                    "src": f"{TREK}/Aquieous_Mineral_Distribution_Options_clon0/MapServer/0",
                    "pts": points(trek_layer("Aquieous_Mineral_Distribution_Options_clon0", 0, C), lambda a: ci(a.get("Class")))}
    hy_cls = [{"id": "CRISM", "label": "CRISM (MRO) detection", "rgb": [120, 220, 255]},
              {"id": "OMEGA", "label": "OMEGA (Mars Express) detection", "rgb": [80, 160, 255]}]
    hi = cls_index(hy_cls)
    L["hydrous"] = {"name": "Hydrous mineral detections", "group": "spectral", "geom": "point", "classes": hy_cls,
                    "what": "Every hydrated-mineral detection of the global CRISM and OMEGA survey",
                    "instruments": "MRO CRISM, Mars Express OMEGA",
                    "cite": "Carter J., Poulet F., Bibring J.-P., Mangold N., Murchie S. 2013, JGR Planets 118, 831",
                    "src": f"{TREK}/Hydrous_Mineral_Detections_OMEGA_CRISM_clon0/MapServer/0",
                    "pts": points(trek_layer("Hydrous_Mineral_Detections_OMEGA_CRISM_clon0", 0, C), lambda a: hi(a.get("Instrument")))}
    L["chlorides"] = {"name": "Chloride salt deposits", "group": "spectral", "geom": "polygon",
                      "classes": [{"id": "chloride", "label": "Chloride-bearing deposit", "rgb": [255, 230, 60]}],
                      "what": "Salt deposits left by evaporating water (ponds, playas): brines, and a target for preserved organics",
                      "instruments": "Mars Odyssey THEMIS",
                      "cite": "Osterloo M.M., Anderson F.S., Hamilton V.E., Hynek B.M. 2010, JGR 115, E10012",
                      "src": f"{TREK}/Chloride_Salt_bearing_Material_THEMIS_clon0/MapServer/0",
                      "items": polygons(trek_layer("Chloride_Salt_bearing_Material_THEMIS_clon0", 0, C), 0.002)}
    ac_cls = [{"id": "new crater", "label": "New impact crater (formed since 1999)", "rgb": [255, 255, 255]},
              {"id": "RSL", "label": "Recurring slope lineae, confirmed", "rgb": [255, 60, 60]},
              {"id": "RSL?", "label": "Recurring slope lineae, partly confirmed", "rgb": [255, 130, 110]},
              {"id": "active gully", "label": "Active gully", "rgb": [255, 170, 0]},
              {"id": "dune gully", "label": "Dune or sandy gully", "rgb": [230, 200, 120]},
              {"id": "icy impact site", "label": "New crater that exposed ice", "rgb": [90, 220, 255]}]
    ai = cls_index(ac_cls)
    L["active"] = {"name": "Present-day activity", "group": "hazard", "geom": "point", "classes": ac_cls,
                   "what": "Mars today: new impacts, seasonal dark streaks (RSL, candidate Special Regions for planetary protection), active gullies, ice exposed by impacts",
                   "instruments": "MRO HiRISE and CTX",
                   "cite": "Daubar et al. 2013 Icarus; McEwen et al. 2014 Nature Geosci.; Ojha et al. 2014 Icarus; Dundas et al. 2014 JGR; Dundas et al. 2015 Icarus",
                   "src": f"{TREK}/RSLs_Gullies_New_IcyCraters_clon0/MapServer/0",
                   "pts": points(trek_layer("RSLs_Gullies_New_IcyCraters_clon0", 0, C), lambda a: ai(a.get("Short_Type")))}
    gu_cls = [{"id": "Poleward", "label": "Gullies, pole-facing", "rgb": [120, 200, 255]},
              {"id": "Equatorward", "label": "Gullies, equator-facing", "rgb": [255, 180, 90]},
              {"id": "other", "label": "Gullies, east, west or no preference", "rgb": [210, 210, 210]}]
    gi = cls_index(gu_cls)
    L["gullies"] = {"name": "Gullies", "group": "ice", "geom": "point", "classes": gu_cls,
                    "what": "Every gully site on 85 % of Mars: young slopes cut by flows of water, CO2 frost or dry debris",
                    "instruments": "MRO CTX",
                    "cite": "Harrison T.N., Osinski G.R., Tornabene L.L., Jones E. 2015, Icarus 252, 236",
                    "src": f"{TREK}/Mars_Fans_Glaciers_Gullies/MapServer/3",
                    "pts": points(trek_layer("Mars_Fans_Glaciers_Gullies", 3, C), lambda a: gi(a.get("Preference")))}
    glf = points(trek_layer("Mars_Fans_Glaciers_Gullies", 1, C), lambda a: 0)
    glf += points(trek_layer("Mars_Fans_Glaciers_Gullies", 4, C), lambda a: 1)
    glf += points(trek_layer("Mars_Fans_Glaciers_Gullies", 0, C), lambda a: 2)
    L["glacial"] = {"name": "Glaciers and glacial valleys", "group": "ice", "geom": "point",
                    "classes": [{"id": "glf", "label": "Glacier-like form (buried ice)", "rgb": [150, 235, 255]},
                                {"id": "recess", "label": "Receding glacier-like form", "rgb": [70, 190, 240]},
                                {"id": "valley", "label": "Supraglacial / proglacial valley", "rgb": [200, 160, 255]}],
                    "what": "Debris-covered mid-latitude glaciers: water ice under a few metres of rock, and records of recent climate",
                    "instruments": "MRO CTX",
                    "cite": "Souness C. et al. 2012, Icarus 217, 243; Brough S. et al. 2016, Icarus 274, 37; Fassett C.I. et al. 2010, Icarus 208, 86",
                    "src": f"{TREK}/Mars_Fans_Glaciers_Gullies/MapServer/0,1,4",
                    "pts": glf}
    L["fans"] = {"name": "Alluvial fans", "group": "water", "geom": "point",
                 "classes": [{"id": "fan", "label": "Large alluvial fan", "rgb": [255, 210, 120]}],
                 "what": "Fans of sediment carried by running water out of crater walls",
                 "instruments": "Mars Odyssey THEMIS, MGS MOLA",
                 "cite": "Moore J.M. & Howard A.D. 2005, JGR 110, E04005; Kraal E.R. et al. 2008, Icarus 194, 101",
                 "src": f"{TREK}/Mars_Fans_Glaciers_Gullies/MapServer/2",
                 "pts": points(trek_layer("Mars_Fans_Glaciers_Gullies", 2, C))}
    L["dunes"] = {"name": "Dune fields", "group": "hazard", "geom": "polygon",
                  "classes": [{"id": "dune", "label": "Dune field (moving sand: soft ground)", "rgb": [235, 175, 70]}],
                  "what": "Moderate to large dune fields between 65 N and 65 S (fields under ~1 km2 are not mapped)",
                  "instruments": "Mars Odyssey THEMIS, MGS MOC",
                  "cite": "Hayward R.K. et al. 2007, Mars Global Digital Dune Database MC2-MC29, USGS Open-File Report 2007-1158",
                  "src": f"{TREK}/Dune_Field/MapServer/0",
                  "items": polygons(trek_layer("Dune_Field", 0, C), 0.01, attr=lambda a: (a.get("Dune_Type") or "").strip() or None)}
    L["valleys"] = {"name": "Valley networks", "group": "water", "geom": "line",
                    "classes": [{"id": "valley", "label": "Valley network (ancient rivers)", "rgb": [90, 170, 255]}],
                    "what": "Branching valleys cut by rivers on early Mars",
                    "instruments": "Mars Odyssey THEMIS, MGS MOLA",
                    "cite": "Hynek B.M., Beach M., Hoke M.R.T. 2010, JGR 115, E09008",
                    "src": f"{TREK}/Hynek_Valley_Networks/MapServer/0",
                    "lines": lines(trek_layer("Hynek_Valley_Networks", 0, C), 0.02)}
    landers = []
    for svc, mission in (("viking_waypoints", "Viking 1"), ("viking2_waypoints", "Viking 2"), ("sojourner_waypoints", "Mars Pathfinder"),
                         ("spirit_waypoints", "Spirit"), ("opportunity_waypoints", "Opportunity"), ("phoenix_waypoints", "Phoenix"),
                         ("InSight_waypoints", "InSight"), ("curiosity_waypoints", "Curiosity"), ("mars2020_waypoints", "Perseverance")):
        for f in trek_layer(svc, 0, C):
            g = f.get("geometry") or {}
            if "x" in g:
                landers.append([r4(lon180(g["x"])), r4(g["y"]), mission, (f["attributes"].get("name") or "").strip()])
    L["landers"] = {"name": "Landers, rovers and their science stops", "group": "missions", "geom": "named",
                    "what": "Where every successful lander and rover set down, and the places they made famous",
                    "cite": "NASA Mars Trek waypoint services (JPL); positions from HiRISE",
                    "src": f"{TREK}/<mission>_waypoints/MapServer/0", "pts": landers}
    trav = []
    for key, name in (("msl", "Curiosity"), ("m2020", "Perseverance")):
        pts, (s0, s1), n = feed_track(FEEDS[key])
        trav.append({"name": name, "sols": [s0, s1], "fixes": n, "src": FEEDS[key], "path": pts})
        print(f"  {name}: {n} localisations, sols {s0}-{s1}, {len(pts)} vertices kept")
    for svc, name in (("spirit_path", "Spirit"), ("opportunity_path", "Opportunity")):
        for p in lines(trek_layer(svc, 0, C), 0.00015):
            trav.append({"name": name, "src": f"{TREK}/{svc}/MapServer/0", "path": p})
    L["traverses"] = {"name": "Rover traverses", "group": "missions", "geom": "track",
                      "what": "Every metre the rovers have driven: Spirit, Opportunity, Curiosity and Perseverance (to their latest localised sol)",
                      "cite": "NASA/JPL MSL and Mars 2020 waypoint feeds; NASA Mars Trek Spirit and Opportunity paths",
                      "src": "mars.nasa.gov/mmgis-maps; trek.nasa.gov", "items": trav}

    doc = {"built": time.strftime("%Y-%m-%d"), "tool": "tools/build_features.py",
           "note": "Coordinates are Mars 2000 planetocentric degrees, east longitude -180..180, rounded to 1e-4 deg (6 m).",
           "layers": L}
    raw = json.dumps(doc, separators=(",", ":")).encode()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(OUT, "wb", mtime=0) as fh:          # mtime 0: the same data gives the same bytes
        fh.write(raw)
    for k, v in L.items():
        n = len(v.get("pts") or v.get("items") or v.get("lines") or [])
        print(f"{k:10s} {n:6d}")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(raw) / 1e6:.1f} MB raw, {OUT.stat().st_size / 1e6:.2f} MB gzip")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
