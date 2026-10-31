"""Point-of-view images for the stations of a site: what the crew will see when they get there, from the rover that
stood on the spot. For every station within a short walk of the rover's track, the rover's own localisations near it
give the sols it was parked there; NASA's raw-image service gives the Navcam (landscape) and Mastcam / Mastcam-Z (colour)
frames taken on those sols. A few are kept per station, scaled for a tablet, with sol, camera, pointing and credit.

  Perseverance  images carry the rover's site and drive index: only frames taken at that exact localisation are used
  Curiosity     images carry no position: only sols strictly between arriving at the spot and the next drive are used,
                so the rover was standing there all day

  python tools/build_pov.py --site jezero --rover m2020
  python tools/build_pov.py --site g_4p811s_137p384e --rover msl

Writes app/data/<site>/pov/<station>_<n>.jpg and pov.json. Raw images: NASA/JPL-Caltech (with MSSS / ASU), public."""
from __future__ import annotations

import argparse
import io
import json
import math
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FEEDS = {"m2020": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json",
         "msl": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"}
RAW = "https://mars.nasa.gov/rss/api/?feed=raw_images&category={cat}&feedtype=json&sol={sol}"
ROVER = {"m2020": ("Perseverance", "mars2020"), "msl": ("Curiosity", "msl")}
NAV = {"m2020": ("NAVCAM_LEFT",), "msl": ("NAV_LEFT_B", "NAV_LEFT_A")}
COLOUR = {"m2020": ("MCZ_LEFT",), "msl": ("MAST_LEFT",)}
UA = {"User-Agent": "MarsNav build_pov (NASA Space Apps 2026; github.com/Aryan221224/MarsNav)"}


def get(url: str, timeout: float = 120) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except OSError:
            if attempt == 3:
                raise
            time.sleep(4 * (attempt + 1))


def hav_m(lon1, lat1, lon2, lat2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3396190 * math.asin(min(1.0, math.sqrt(h)))


def site_paths(site: str):
    sites = json.loads((ROOT / "app" / "data" / "sites.json").read_text())
    s = next(x for x in sites if x["id"] == site)
    out = ROOT / "app" / "data" / s["path"]
    man = json.loads((out / "manifest.json").read_text())
    return out, man


def usable(im, rover, keep_cams) -> bool:
    if im["camera"]["instrument"] not in keep_cams:
        return False
    if str(im.get("sample_type", "")).lower() not in ("full",):
        return False
    if rover == "m2020":
        ext = im.get("extended", {})
        dim = str(ext.get("dimension", "(0,0)")).strip("()").split(",")
        if min(int(float(v)) for v in dim) < 700:            # thumbnails and small subframes
            return False
        if "ND" in str(im["camera"].get("filter_name", "")):  # neutral-density solar filters: pictures of the sun
            return False
        try:
            if not -40 <= float(ext.get("mastEl", 0)) <= 15:  # pointed at the sky (dust, clouds) or down at the rover's deck
                return False
        except ValueError:
            pass
    return True


def near_in_time(im, picked, gap_s: float = 300) -> bool:
    """Frames seconds apart show the same scene twice (stereo pairs, repeats): keep views at least 5 minutes apart."""
    from datetime import datetime
    def t(x):
        try:
            return datetime.fromisoformat(str(x.get("date_taken_utc", "")).replace("Z", ""))
        except ValueError:
            return None
    a = t(im)
    return a is not None and any((b := t(x["im"])) is not None and abs((a - b).total_seconds()) < gap_s for x in picked)


def a_view(pic) -> bool:
    """A picture of the ground and horizon, not of the sun or an empty sky: enough texture, not mostly black."""
    import numpy as np
    g = np.asarray(pic.convert("L").resize((160, 120)), np.float32)
    return g.std() >= 14 and (g < 20).mean() < 0.4


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--rover", required=True, choices=sorted(FEEDS))
    ap.add_argument("--radius", type=float, default=60.0, help="a station counts if the rover stopped this close (m)")
    ap.add_argument("--per-station", type=int, default=4)
    ap.add_argument("--max-px", type=int, default=960)
    a = ap.parse_args()
    from PIL import Image
    name, cat = ROVER[a.rover]
    out, man = site_paths(a.site)
    fixes = [f["properties"] for f in json.loads(get(FEEDS[a.rover]))["features"] if f["properties"].get("lon") is not None]
    fixes.sort(key=lambda p: (p["sol"], p.get("drive", 0)))
    (out / "pov").mkdir(exist_ok=True)
    index, sol_cache = {}, {}

    def sol_images(sol):
        if sol not in sol_cache:
            sol_cache[sol] = json.loads(get(RAW.format(cat=cat, sol=sol))).get("images", [])
        return sol_cache[sol]

    for t in man["targets"]:
        near = sorted((hav_m(t["lon"], t["lat"], p["lon"], p["lat"]), k) for k, p in enumerate(fixes))
        near = [(d, k) for d, k in near if d <= a.radius][:6]
        if not near:
            continue
        picked, seen = [], set()
        for d, k in near:
            p = fixes[k]
            nxt = next((q for q in fixes[k + 1:] if (q.get("site"), q.get("drive")) != (p.get("site"), p.get("drive"))), None)
            if a.rover == "m2020":
                sols = [p["sol"]] + list(range(p["sol"] + 1, min(nxt["sol"] + 1 if nxt else p["sol"] + 3, p["sol"] + 4)))
                match = lambda im, p=p: str(im.get("site")) == str(p.get("site")) and str(im.get("drive")) == str(p.get("drive"))  # noqa: E731
            else:
                sols = list(range(p["sol"] + 1, nxt["sol"])) if nxt else [p["sol"] + 1]
                sols = sols[:4]
                match = lambda im: True  # noqa: E731
            for sol in sols:
                ims = [im for im in sol_images(sol) if match(im)]
                for cams, role in ((NAV[a.rover], "navcam"), (COLOUR[a.rover], "colour")):
                    have = sum(1 for x in picked if x["role"] == role)
                    for im in [i for i in ims if usable(i, a.rover, cams)]:
                        if have >= a.per_station // 2:
                            break
                        if im["imageid"] in seen or near_in_time(im, picked):
                            continue
                        seen.add(im["imageid"])
                        src = im["image_files"].get("large") or im["image_files"].get("medium") or im["image_files"]["full_res"]
                        pic = Image.open(io.BytesIO(get(src))).convert("RGB")
                        if not a_view(pic):
                            continue
                        picked.append({"im": im, "role": role, "fix": p, "dist": d, "pic": pic, "src": src})
                        have += 1
            if len(picked) >= a.per_station:
                break
        rows = []
        for n, x in enumerate(picked[:a.per_station]):
            im, p, pic, src = x["im"], x["fix"], x["pic"], x["src"]
            pic.thumbnail((a.max_px, a.max_px))
            fn = f"{t['id']}_{n + 1}.jpg"
            pic.save(out / "pov" / fn, "JPEG", quality=80, optimize=True)
            ext = im.get("extended") or {}
            cam = {"NAVCAM_LEFT": "Navcam", "NAV_LEFT_B": "Navcam", "NAV_LEFT_A": "Navcam", "MCZ_LEFT": "Mastcam-Z", "MAST_LEFT": "Mastcam"}.get(
                im["camera"]["instrument"], im["camera"]["instrument"])
            az = ext.get("mastAz")
            rows.append({"file": f"pov/{fn}", "rover": name, "camera": cam, "sol": im["sol"], "utc": im.get("date_taken_utc"),
                         "lmst": (im.get("date_taken_mars") or "").split("M")[-1][:5] if im.get("date_taken_mars") not in (None, "UNK") else None,
                         "azimuth_deg": round(float(az), 0) if az not in (None, "", "UNK") else None,
                         "rover_m_from_station": round(x["dist"]), "credit": im.get("credit") or "NASA/JPL-Caltech",
                         "source": src, "imageid": im["imageid"]})
        if rows:
            index[t["id"]] = {"name": t["name"], "images": rows}
            print(f"{t['id']:6s} {len(rows)} images (rover {rows[0]['rover_m_from_station']} m away, sols {sorted({r['sol'] for r in rows})})")
    doc = {"site": a.site, "rover": name, "built": time.strftime("%Y-%m-%d"), "tool": "tools/build_pov.py",
           "note": f"Raw images from {name} at the spots it stood nearest each station (NASA raw-image service). Not calibrated, "
                   "not mosaicked: what a camera at head height saw there.", "stations": index}
    (out / "pov.json").write_text(json.dumps(doc, indent=1))
    sf = ROOT / "app" / "data" / "sites.json"                     # the planner fetches pov.json only for sites marked
    sites = json.loads(sf.read_text())
    for s in sites:
        if s["id"] == a.site:
            s["pov"] = True
    sf.write_text(json.dumps(sites, indent=1, ensure_ascii=False))
    size = sum(f.stat().st_size for f in (out / "pov").glob("*.jpg"))
    print(f"wrote {out.relative_to(ROOT)}/pov.json: {len(index)} stations, {size / 1e6:.1f} MB of images")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
