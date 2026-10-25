"""Figure for the rover case study: Perseverance's real route vs MarsNav's routes between the same two points.

Run after node validation/rover_case_study.mjs:  python tools/figures/render_rover_case_study.py . submission/screens/20_rover_case_study.jpg
"""
import json, gzip, math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = sys.argv[2] if len(sys.argv) > 2 else "submission/screens/20_rover_case_study.jpg"
# Barlow TTFs (SIL OFL) from MARSNAV_FONTS if set; otherwise a system sans font
import os
FD = os.environ.get("MARSNAV_FONTS", "")


def F(name, size):
    for cand in ([os.path.join(FD, name)] if FD else []) + ["arial.ttf", "DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(cand, size)
        except OSError:
            continue
    return ImageFont.load_default()

m = json.load(open(f"{ROOT}/app/data/manifest.json"))
G = m["grids"]["ops10"]
R = json.load(open(f"{ROOT}/validation/results/rover_case_study.json"))
c = R["case"]
RM = 3396190.0
D = math.pi / 180
KX = RM * math.cos(m["projection"]["lat_ts"] * D)


def px(lon, lat):  # pixel in the 5 m orthoimage
    return ((KX * lon * D - G["x0"]) / 5.0, (G["y0"] - RM * lat * D) / 5.0)


def layer(name):
    L = m["layers"][name]
    dt = {"uint8": np.uint8, "uint16": np.uint16, "int16": np.int16, "float32": np.float32}[L["dtype"]]
    a = np.frombuffer(gzip.open(f"{ROOT}/app/data/" + L["file"]).read(), dtype=dt)
    return (a.astype(np.float32) / L["scale"] - L["offset"]).reshape(G["height"], G["width"])


img = Image.open(f"{ROOT}/app/data/ortho5.jpg").convert("RGB")
sand = layer("sand")
hab = next(t for t in m["targets"] if t["id"] == "HAB")
paths = {k: [px(lo, la) for lo, la in c[k]["path"]] for k in ["rover", "marsnav_safest", "crew_on_foot"]}
allp = sum(paths.values(), []) + [px(hab["lon"], hab["lat"])]
pad = 70
x0 = int(max(0, min(p[0] for p in allp) - pad)); x1 = int(min(img.width, max(p[0] for p in allp) + pad))
y0 = int(max(0, min(p[1] for p in allp) - pad)); y1 = int(min(img.height, max(p[1] for p in allp) + pad))
crop = img.crop((x0, y0, x1, y1))
# darken and cool the base slightly so the routes carry the eye
crop = Image.blend(crop, Image.new("RGB", crop.size, (18, 22, 30)), 0.28).convert("RGBA")
s = sand[y0 // 2:(y1 + 1) // 2 + 1, x0 // 2:(x1 + 1) // 2 + 1]
mask = (s > 0.5).astype(np.uint8)
ov = np.zeros(mask.shape + (4,), np.uint8)
ov[..., 0], ov[..., 1], ov[..., 2], ov[..., 3] = 240, 150, 50, mask * 105
ov = Image.fromarray(ov, "RGBA").resize((mask.shape[1] * 2, mask.shape[0] * 2), Image.NEAREST)
ov = ov.crop((x0 % 2, y0 % 2, x0 % 2 + crop.width, y0 % 2 + crop.height))
crop = Image.alpha_composite(crop, ov)

MAPW = 1400
S = MAPW / crop.width
MAPH = int(crop.height * S)
crop = crop.resize((MAPW, MAPH), Image.LANCZOS)
PANEL = 520
TOP, BOT = 112, 46
W, H = MAPW + PANEL, TOP + MAPH + BOT
BG, INK, DIM, LINE = (18, 25, 35), (230, 234, 239), (141, 154, 171), (52, 68, 90)
CYAN, GREEN, WHITE, ORANGE = (90, 200, 250), (95, 225, 130), (245, 245, 245), (240, 150, 50)
canvas = Image.new("RGB", (W, H), BG)
canvas.paste(crop.convert("RGB"), (0, TOP))
d = ImageDraw.Draw(canvas, "RGBA")


def P(pts):
    return [((x - x0) * S, (y - y0) * S + TOP) for x, y in pts]


def dashed(pts, fill, width, dash=14, gap=10):
    pts = P(pts)
    acc, on = 0.0, True
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        L = math.hypot(bx - ax, by - ay)
        t = 0.0
        while t < L:
            step = min((dash if on else gap) - acc, L - t)
            if on:
                d.line([(ax + (bx - ax) * t / L, ay + (by - ay) * t / L), (ax + (bx - ax) * (t + step) / L, ay + (by - ay) * (t + step) / L)], fill=fill, width=width)
            t += step; acc += step
            if acc >= (dash if on else gap) - 1e-9:
                acc, on = 0.0, not on


# straight line (reference)
d.line(P([paths["rover"][0], paths["rover"][-1]]), fill=(255, 255, 255, 90), width=2)
# routes: halo then colour
for k, col, w in [("rover", CYAN, 6), ("marsnav_safest", GREEN, 6)]:
    d.line(P(paths[k]), fill=(0, 0, 0, 150), width=w + 4, joint="curve")
    d.line(P(paths[k]), fill=col, width=w, joint="curve")
dashed(paths["crew_on_foot"], (0, 0, 0, 160), 7)
dashed(paths["crew_on_foot"], WHITE, 3)

fL, fLb, fS = F("Barlow-SemiBold.ttf", 22), F("Barlow-Bold.ttf", 24), F("Barlow-Medium.ttf", 18)


def pin(lonlat_px, label, sub, dx, dy, anchor="la"):
    X, Y = P([lonlat_px])[0]
    d.ellipse((X - 10, Y - 10, X + 10, Y + 10), fill=WHITE, outline=(0, 0, 0), width=3)
    tx, ty = X + dx, Y + dy
    for o in [(-1, -1), (1, 1), (-1, 1), (1, -1), (0, 2)]:
        d.text((tx + o[0], ty + o[1]), label, font=fLb, fill=(0, 0, 0, 200), anchor=anchor)
        d.text((tx + o[0], ty + 26 + o[1]), sub, font=fS, fill=(0, 0, 0, 200), anchor=anchor)
    d.text((tx, ty), label, font=fLb, fill=WHITE, anchor=anchor)
    d.text((tx, ty + 26), sub, font=fS, fill=(220, 226, 234), anchor=anchor)


A, B = paths["rover"][0], paths["rover"][-1]
pin(A, "A  Issole, Séítah", f"start, sol {c['from']['sol']}", 18, 8)
pin(B, "B  Amalik, delta front", f"end, sol {c['to']['sol']}", 16, -72)
# landing site
HX, HY = P([px(hab["lon"], hab["lat"])])[0]
d.rectangle((HX - 8, HY - 8, HX + 8, HY + 8), fill=(255, 205, 80), outline=(0, 0, 0), width=2)
for o in [(-1, -1), (1, 1)]:
    d.text((HX + 14 + o[0], HY - 12 + o[1]), "Landing site (crew habitat)", font=fS, fill=(0, 0, 0, 200))
d.text((HX + 14, HY - 12), "Landing site (crew habitat)", font=fS, fill=(255, 225, 150))

# region labels (placed from the map: Seitah lies between A and B, south of the rover's loop)
def region(lon, lat, text):
    X, Y = P([px(lon, lat)])[0]
    d.text((X, Y), text, font=F("BarlowCondensed-SemiBold.ttf", 26), fill=(255, 255, 255, 150), anchor="mm")
region(77.4250, 18.4455, "S É Í T A H")

# scale bar (1 km) and north arrow
km = 1000 / 5.0 * S
sx, sy = 28, TOP + MAPH - 34
d.rectangle((sx - 10, sy - 30, sx + km + 70, sy + 18), fill=(0, 0, 0, 140))
d.line([(sx, sy), (sx + km, sy)], fill=WHITE, width=4)
for xx in (sx, sx + km / 2, sx + km):
    d.line([(xx, sy - 7), (xx, sy + 7)], fill=WHITE, width=3)
d.text((sx + km + 10, sy), "1 km", font=fS, fill=WHITE, anchor="lm")
d.text((sx, sy - 12), "0", font=F("Barlow-Medium.ttf", 14), fill=WHITE, anchor="ms")
nx, ny = MAPW - 40, TOP + 40
d.polygon([(nx, ny - 22), (nx - 11, ny + 10), (nx, ny + 3), (nx + 11, ny + 10)], fill=WHITE, outline=(0, 0, 0))
d.text((nx, ny + 26), "N", font=fL, fill=WHITE, anchor="mm")

# ---------------------------------------------------------------- header
d.text((28, 24), "SAME TRIP, TWO NAVIGATORS", font=F("BarlowCondensed-SemiBold.ttf", 22), fill=DIM)
d.text((28, 50), "Perseverance's real route vs MarsNav, between the same two points in Jezero crater", font=F("Barlow-SemiBold.ttf", 34), fill=INK)
d.line([(0, TOP - 1), (W, TOP - 1)], fill=LINE, width=2)

# ---------------------------------------------------------------- panel
px0 = MAPW + 30
y = TOP + 24


def legend(col, kind, title, lines):
    global y
    if kind == "solid":
        d.line([(px0, y + 13), (px0 + 46, y + 13)], fill=col, width=6)
    elif kind == "dash":
        for k in range(3):
            d.line([(px0 + k * 17, y + 13), (px0 + k * 17 + 11, y + 13)], fill=col, width=4)
    else:
        d.rectangle((px0 + 6, y + 3, px0 + 40, y + 23), fill=col + (120,))
    d.text((px0 + 62, y), title, font=F("Barlow-Bold.ttf", 24), fill=INK)
    y += 32
    for ln in lines:
        d.text((px0 + 62, y), ln, font=F("Barlow-Medium.ttf", 20), fill=DIM)
        y += 26
    y += 16


r, sf, cr = c["rover"], c["marsnav_safest"], c["crew_on_foot"]
legend(CYAN, "solid", "Perseverance, actual route", [f"{r['metrics']['length_m']/1000:.1f} km over {r['sols_elapsed']} sols ({r['drive_sols']} with recorded drives)",
                                                        "JPL routed around Séítah's rocks and sand"])
legend(GREEN, "solid", "MarsNav, robotic scout", [f"{sf['metrics']['length_m']/1000:.2f} km, planned in {c['planning_s']:.1f} s",
                                                  f"about {sf['drive_h']:.0f} h of driving at Perseverance speeds"])
legend(WHITE, "dash", "MarsNav, suited crew", [f"{cr['km']:.2f} km, {cr['eva_h']:.1f} h EVA from the habitat",
                                               f"walk-home margin never below {cr['min_walk_home_margin']*100:.0f} %"])
legend(ORANGE, "box", "Mapped sand bedforms", ["from 1 m HiRISE elevation models"])

d.line([(px0, y), (W - 30, y)], fill=LINE, width=2)
y += 18
d.text((px0, y), "MEASURED ON THE SAME 1 m TERRAIN", font=F("BarlowCondensed-SemiBold.ttf", 20), fill=DIM)
y += 32
cols = [px0, px0 + 236, px0 + 330, px0 + 420]
d.text((cols[1], y), "Rover", font=F("Barlow-SemiBold.ttf", 19), fill=CYAN)
d.text((cols[2], y), "Scout", font=F("Barlow-SemiBold.ttf", 19), fill=GREEN)
d.text((cols[3], y), "Crew", font=F("Barlow-SemiBold.ttf", 19), fill=WHITE)
y += 30
rm, sm, cm = r["metrics"], sf["metrics"], cr["metrics"]
rows = [("Distance (km)", lambda q: f"{q['length_m']/1000:.1f}"),
        ("Climb (m)", lambda q: f"{q['climb_m']:.0f}"),
        ("Steepest ground (°)", lambda q: f"{q['slope_max_deg']:.0f}"),
        ("Ground over 15° (m)", lambda q: f"{q['over15_m']:.0f}"),
        ("Average slope (°)", lambda q: f"{q['slope_mean_deg']:.1f}"),
        ("Sand bedforms (m)", lambda q: f"{q['sand_m']:.0f}"),
        ("Rocky ground (m)", lambda q: f"{q['rocky_m']:.0f}")]
fV = F("Barlow-SemiBold.ttf", 21)
for i, (lab, f) in enumerate(rows):
    if i % 2 == 0:
        d.rectangle((px0 - 8, y - 4, W - 22, y + 26), fill=(255, 255, 255, 10))
    d.text((px0, y), lab, font=F("Barlow-Medium.ttf", 20), fill=INK)
    for col, q in zip(cols[1:], (rm, sm, cm)):
        d.text((col, y), f(q), font=fV, fill=INK)
    y += 32
y += 8
for ln in ["Rover values are measured along the public waypoint",
           "record (one point per drive), so they are approximate."]:
    d.text((px0, y), ln, font=F("Barlow-Italic.ttf", 17), fill=DIM)
    y += 22

# ---------------------------------------------------------------- footer
d.line([(0, TOP + MAPH), (W, TOP + MAPH)], fill=LINE, width=2)
d.text((28, TOP + MAPH + 13), "Base map: CTX orthomosaic (NASA/JPL/MSSS, USGS). Terrain: HiRISE DTMs (NASA/JPL/UArizona, USGS). Rover track: NASA/JPL "
       "Mars 2020 waypoints. Computed by validation/rover_case_study.mjs.", font=F("Barlow-Medium.ttf", 16), fill=DIM)
canvas.save(OUT, quality=92)
print(OUT, canvas.size)
