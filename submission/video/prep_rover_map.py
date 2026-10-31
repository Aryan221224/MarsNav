"""Basemap and route geometry for the video's "same trip as Perseverance" shot.

Mosaics the app's own 2 m HiRISE relief tiles (app/data/hi2, from the 1 m DTMs) over the 5 m CTX orthoimage for the
area of the Seitah -> delta front trip, and projects the routes from validation/results/rover_case_study.json into
that image: Perseverance's real route (NASA/JPL waypoints) and MarsNav's suited-crew route between the same two
points. Nothing is redrawn by hand; every point comes from the validation output.

    python3 submission/video/prep_rover_map.py [repo-root] [out-dir]
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "submission/video/build/rover")
os.makedirs(OUT, exist_ok=True)

m = json.load(open(f"{ROOT}/app/data/manifest.json"))
G = m["grids"]["ops10"]
im = json.load(open(f"{ROOT}/app/data/imagery.json"))
case = json.load(open(f"{ROOT}/validation/results/rover_case_study.json"))["case"]
RM = 3396190.0
D = math.pi / 180
KX = RM * math.cos(m["projection"]["lat_ts"] * D)
RES = 2.0  # metres per pixel of the mosaic


def metres(lon, lat):
    """Position in metres from the ops grid's top-left corner (x east, y south)."""
    return KX * lon * D - G["x0"], G["y0"] - RM * lat * D


paths = {k: [metres(lo, la) for lo, la in case[k]["path"]] for k in ("rover", "crew_on_foot")}
targets = {t["id"]: t for t in m["targets"]}
pts = paths["rover"] + paths["crew_on_foot"]
# frame the trip at 16:9 with a margin
x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
# the routes sit in the upper part of the frame, clear of the burned-in captions at the bottom
w = max(x1 - x0, (y1 - y0) * 1.55 * 16 / 9) * 1.12
h = w * 9 / 16
X0, Y0 = cx - w / 2, cy - h * 0.43
Wpx, Hpx = int(round(w / RES)), int(round(h / RES))

# base: the 5 m orthoimage, resampled to 2 m
ortho = Image.open(f"{ROOT}/app/data/ortho5.jpg").convert("RGB")
o_box = (X0 / 5.0, Y0 / 5.0, (X0 + w) / 5.0, (Y0 + h) / 5.0)
base = ortho.resize((Wpx, Hpx), Image.LANCZOS, box=o_box)

# HiRISE relief tiles on top where they hold data
tiles = []
for t in im["hi2"]["tiles"]:
    tx0, ty0 = t["c0"] * G["res"], t["r0"] * G["res"]           # tile corner in metres
    size_m = t["cells"] * G["res"]
    if tx0 > X0 + w or ty0 > Y0 + h or tx0 + size_m < X0 or ty0 + size_m < Y0 or t["valid"] <= 0:
        continue
    tile = Image.open(f"{ROOT}/app/data/{t['file']}").convert("RGB")
    scale = (size_m / RES) / tile.width
    if abs(scale - 1) > 1e-6:
        tile = tile.resize((round(tile.width * scale), round(tile.height * scale)), Image.LANCZOS)
    mask = tile.convert("L").point(lambda v: 255 if v > 6 else 0)   # pixels with data: anything not near-black
    at = (round((tx0 - X0) / RES), round((ty0 - Y0) / RES))
    under = np.asarray(base.crop((at[0], at[1], at[0] + tile.width, at[1] + tile.height)), np.float32)
    mk = np.asarray(mask) > 0
    tv = np.asarray(tile, np.float32)
    gain = under[mk].mean(0) / np.maximum(tv[mk].mean(0), 1) if mk.sum() > 1000 else np.ones(3)
    tiles.append((tv, mask, at, gain))
# display only: the tiles carry different tints, which show as seams. Each tile is scaled towards the continuous CTX
# orthoimage under it, relative to the median of all tiles, so the seams fade and the overall brightness stays.
if tiles:
    med = np.median(np.array([g for _, _, _, g in tiles]), axis=0)
    for tv, mask, at, gain in tiles:
        base.paste(Image.fromarray(np.clip(tv * gain / med, 0, 255).astype(np.uint8)), at, mask)

base.save(os.path.join(OUT, "base.jpg"), quality=94)


def to_px(p):
    return [round((p[0] - X0) / RES, 2), round((p[1] - Y0) / RES, 2)]


def tpx(tid):
    t = targets[tid]
    return to_px(metres(t["lon"], t["lat"]))


rov = case["rover"]
crew = case["crew_on_foot"]
geo = {
    "size": [Wpx, Hpx],
    "res_m": RES,
    "rover": [to_px(p) for p in paths["rover"]],
    "crew": [to_px(p) for p in paths["crew_on_foot"]],
    "from": {"name": "Issole, Séítah", "px": to_px(metres(case["from"]["lon"], case["from"]["lat"]))},
    "to": {"name": "Amalik, delta front", "px": to_px(metres(case["to"]["lon"], case["to"]["lat"]))},
    "habitat": {"name": "Habitat", "px": tpx("HAB")},
    "numbers": {
        "rover_km": round(rov["metrics"]["length_m"] / 1000, 2),
        "rover_sols": rov["sols_elapsed"],
        "rover_sol_from": case["from"]["sol"],
        "rover_sol_to": case["to"]["sol"],
        "crew_km": round(crew["km"], 2),
        "crew_min": round(crew["eva_h"] * 60, 1),
        "crew_min_margin_pct": round(100 * crew["min_walk_home_margin"]),
    },
}
json.dump(geo, open(os.path.join(OUT, "geo.json"), "w"), ensure_ascii=False, indent=1)
print("basemap", Wpx, "x", Hpx, "px at", RES, "m/px;", json.dumps(geo["numbers"]))
