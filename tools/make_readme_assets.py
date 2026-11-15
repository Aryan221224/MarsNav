"""Build the README's pictures: the banner, the result charts and the screenshot gallery.

Every number drawn here is read from validation/results/headline.json and
validation/results/shielding_murray_buttes.json (written by the validation scripts), so the pictures cannot drift from
the results; tests/headline_numbers.test.mjs checks the same files against the README text. Screenshots are captures
of the running app (submission/screens, tools/guide/assets/img), resized.

    python tools/make_readme_assets.py        # writes docs/img/readme/
"""
import json
import os
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "img", "readme")
FONTS = os.path.join(ROOT, "tools", "guide", "assets", "fonts")
SCREENS = os.path.join(ROOT, "submission", "screens")
GUIDE = os.path.join(ROOT, "tools", "guide", "assets", "img")
H = json.load(open(os.path.join(ROOT, "validation", "results", "headline.json")))
SH = json.load(open(os.path.join(ROOT, "validation", "results", "shielding_murray_buttes.json")))

BG, INK, DIM, LINE = (11, 15, 20), (242, 245, 248), (150, 162, 176), (40, 50, 62)
ACCENT, OK, BAD, CYAN = (216, 165, 122), (62, 224, 126), (255, 116, 112), (60, 203, 255)
hexc = lambda c: "#%02x%02x%02x" % c


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def fit(im, w, h):
    """Cover-crop an image to w x h."""
    r = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * r), round(im.height * r)), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def card(base, im, box, radius=14, border=LINE):
    x, y, w, h = box
    im = fit(im.convert("RGB"), w, h)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius, fill=255)
    shadow = Image.new("RGBA", (w + 40, h + 40), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((20, 24, w + 20, h + 24), radius, fill=(0, 0, 0, 170))
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(12)), (x - 20, y - 20))
    base.paste(im, (x, y), mask)
    ImageDraw.Draw(base).rounded_rectangle((x, y, x + w - 1, y + h - 1), radius, outline=border, width=2)


def hero():
    W, Hh = 1600, 760
    base = Image.new("RGBA", (W, Hh), BG + (255,))
    # warm Mars glow behind the collage
    glow = Image.new("RGBA", (W, Hh), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((760, -220, 1900, 900), fill=(150, 70, 35, 120))
    base.alpha_composite(glow.filter(ImageFilter.GaussianBlur(120)))
    d = ImageDraw.Draw(base)
    # collage: planner (back), helmet visor (front), wrist cuff (side)
    card(base, Image.open(os.path.join(SCREENS, "13_landing_mode.jpg")), (1040, 40, 520, 300))
    card(base, Image.open(os.path.join(SCREENS, "01_plan_routes.jpg")), (800, 210, 620, 355))
    card(base, Image.open(os.path.join(GUIDE, "g15_visor.jpg")), (880, 420, 560, 315), border=ACCENT)
    cuff = Image.open(os.path.join(GUIDE, "g18_cuff_c0_0_480_1150.jpg")).crop((0, 0, 480, 700))
    card(base, cuff, (1440, 360, 130, 190))
    # text block
    logo = Image.open(os.path.join(ROOT, "app", "logo-192.png")).convert("RGBA").resize((92, 92), Image.LANCZOS)
    base.alpha_composite(logo, (64, 64))
    d.text((172, 70), "MARSNAV", font=font("BarlowCondensed-Bold.ttf", 76), fill=INK)
    d.text((176, 146), "NASA SPACE APPS 2026  ·  MARTIAN MAP", font=font("BarlowCondensed-SemiBold.ttf", 22), fill=ACCENT)
    d.text((64, 214), "Every step,", font=font("Barlow-Bold.ttf", 64), fill=INK)
    d.text((64, 284), "a way home.", font=font("Barlow-Bold.ttf", 64), fill=ACCENT)
    body = font("Barlow-Regular.ttf", 25)
    for k, line in enumerate(["Landing-site selection and EVA navigation", "for the first humans on Mars, on real",
                              "NASA and USGS data. Live suit telemetry.", "No GPS. No Earth link needed."]):
        d.text((66, 380 + 34 * k), line, font=body, fill=DIM)
    # three result chips, from headline.json
    cl = H["closed_loop"]
    chips = [(f"{cl['closed_dips']} of {cl['runs']}", "crews into the reserve", f"{cl['open_dips']} of {cl['runs']} on a fixed plan"),
             ("66", "landing sites screened", "on NASA's criteria"),
             ("1 m", "HiRISE terrain,", "checked vs Perseverance")]
    big, small = font("BarlowCondensed-Bold.ttf", 44), font("Barlow-Medium.ttf", 17)
    for k, (num, a, b) in enumerate(chips):
        x, y = 64 + k * 240, 560
        d.rounded_rectangle((x, y, x + 224, y + 132), 12, fill=(20, 27, 35), outline=LINE, width=2)
        d.text((x + 18, y + 10), num, font=big, fill=OK if k == 0 else INK)
        d.text((x + 18, y + 70), a, font=small, fill=INK)
        d.text((x + 18, y + 95), b, font=small, fill=DIM)
    base.convert("RGB").save(os.path.join(OUT, "hero.jpg"), quality=88, optimize=True, progressive=True)


SVG_FONT = "font-family=\"Barlow, 'Segoe UI', Helvetica, Arial, sans-serif\""


def svg_wrap(w, h, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" {SVG_FONT}>'
            f'<rect width="{w}" height="{h}" rx="14" fill="{hexc(BG)}"/>{body}</svg>\n')


def results_chart():
    """Validation at a glance: each result as a point with its 95 % interval on a 0-100 % scale."""
    cl, det, sl, fn = H["closed_loop"], H["detour"], H["slope"], H["false_nogo"]
    rows = [
        ("Closed loop: crews that dipped into the reserve", f"{cl['closed_dips']} of {cl['runs']}", 100 * cl["closed_dips"] / cl["runs"], cl["closed_ci95_pct"], OK),
        ("Same EVAs flown on the fixed plan", f"{cl['open_dips']} of {cl['runs']}", 100 * cl["open_dips"] / cl["runs"], cl["open_ci95_pct"], BAD),
        ("Rover's real path safer than the straight line (JPL's choices)", f"{det['k']} of {det['n']}", det["pct"], det["ci95_pct"], CYAN),
        ("Walking slope at or above the rover's measured tilt", f"{sl['k']} of {sl['n']}", sl["pct"], sl["ci95_pct"], CYAN),
        ("False no-go at real Perseverance positions", f"{fn['k']} of {fn['n']}", fn["pct"], fn["ci95_pct"], CYAN),
    ]
    W, x0, x1, top, step = 1200, 560, 1150, 96, 66
    Hh = top + step * len(rows) + 70
    b = [f'<text x="40" y="48" font-size="26" font-weight="700" fill="{hexc(INK)}">Checked, with 95 % intervals</text>',
         f'<text x="40" y="76" font-size="16" fill="{hexc(DIM)}">Points: measured share. Bars: 95 % interval (Clopper-Pearson for the 40 EVAs, Wilson for the rest). '
         f'Exact sign test on the paired EVAs: p = {cl["sign_test_p"]:.1e}</text>']
    X = lambda p: x0 + (x1 - x0) * p / 100
    for t in range(0, 101, 25):
        b.append(f'<line x1="{X(t):.1f}" y1="{top - 10}" x2="{X(t):.1f}" y2="{top + step * len(rows) - 20}" stroke="{hexc(LINE)}"/>')
        b.append(f'<text x="{X(t):.1f}" y="{top + step * len(rows) + 4}" font-size="14" fill="{hexc(DIM)}" text-anchor="middle">{t} %</text>')
    for k, (label, count, p, ci, col) in enumerate(rows):
        y = top + k * step + 18
        b.append(f'<text x="40" y="{y - 4}" font-size="17" fill="{hexc(INK)}">{escape(label)}</text>')
        b.append(f'<text x="40" y="{y + 18}" font-size="15" fill="{hexc(DIM)}">{escape(count)}  ·  95 % CI {ci[0]:.0f}–{ci[1]:.0f} %</text>')
        b.append(f'<line x1="{X(ci[0]):.1f}" y1="{y}" x2="{X(ci[1]):.1f}" y2="{y}" stroke="{hexc(col)}" stroke-width="6" stroke-linecap="round" opacity="0.45"/>')
        b.append(f'<circle cx="{X(p):.1f}" cy="{y}" r="9" fill="{hexc(col)}"/>')
    open(os.path.join(OUT, "results.svg"), "w").write(svg_wrap(W, Hh, "".join(b)))


def shielding_chart():
    """The terrain-shielding check: dose change vs wall height at the measured 19 % blocked sky, with and without the
    butte's own albedo, against RAD's measurement."""
    walls = SH["result"]["published_geometry_walls"]
    meas = SH["measured"]["dose_change_pct"]
    W, Hh, x0, x1, y0, y1 = 1200, 520, 110, 1150, 110, 440
    hs = [w["wall_deg"] for w in walls]
    lo, hi = min(hs), max(hs)
    X = lambda h: x0 + (x1 - x0) * (h - lo) / (hi - lo)
    Y = lambda v: y0 + (y1 - y0) * (0 - v) / 18      # 0 to -18 %
    b = [f'<text x="40" y="48" font-size="26" font-weight="700" fill="{hexc(INK)}">Terrain radiation shielding vs Curiosity RAD</text>',
         f'<text x="40" y="76" font-size="16" fill="{hexc(DIM)}">By a Murray Butte that hid {SH["measured"]["blocked_sky_pct"]} % of the sky, RAD measured about {meas:.0f} % dose. '
         f'MarsNav\'s formula for walls that hide the same share of sky:</text>']
    for v in range(0, -19, -3):
        b.append(f'<line x1="{x0}" y1="{Y(v):.1f}" x2="{x1}" y2="{Y(v):.1f}" stroke="{hexc(LINE)}"/>')
        b.append(f'<text x="{x0 - 12}" y="{Y(v) + 5:.1f}" font-size="14" fill="{hexc(DIM)}" text-anchor="end">{v} %</text>')
    for h in hs:
        b.append(f'<text x="{X(h):.1f}" y="{y1 + 26}" font-size="14" fill="{hexc(DIM)}" text-anchor="middle">{h}°</text>')
    b.append(f'<text x="{(x0 + x1) / 2}" y="{y1 + 54}" font-size="15" fill="{hexc(DIM)}" text-anchor="middle">height of the wall (elevation angle), azimuth width set so 19 % of the sky is hidden</text>')
    b.append(f'<rect x="{x0}" y="{Y(meas + 1):.1f}" width="{x1 - x0}" height="{Y(meas - 1) - Y(meas + 1):.1f}" fill="{hexc(ACCENT)}" opacity="0.18"/>')
    b.append(f'<line x1="{x0}" y1="{Y(meas):.1f}" x2="{x1}" y2="{Y(meas):.1f}" stroke="{hexc(ACCENT)}" stroke-width="2" stroke-dasharray="8 6"/>')
    b.append(f'<text x="{x1 - 8}" y="{Y(meas) - 10:.1f}" font-size="16" fill="{hexc(ACCENT)}" text-anchor="end">RAD measured ≈ {meas:.0f} %</text>')
    for key, col, name in (("change_pct", OK, "MarsNav (with the butte's own albedo)"), ("change_pct_no_albedo", BAD, "Without albedo")):
        pts = " ".join(f"{X(w['wall_deg']):.1f},{Y(w[key]):.1f}" for w in walls)
        b.append(f'<polyline points="{pts}" fill="none" stroke="{hexc(col)}" stroke-width="4" stroke-linejoin="round"/>')
        for w in walls:
            b.append(f'<circle cx="{X(w["wall_deg"]):.1f}" cy="{Y(w[key]):.1f}" r="5" fill="{hexc(col)}"/>')
    b.append(f'<rect x="{x0 + 14}" y="{y1 - 70}" width="14" height="14" fill="{hexc(OK)}"/><text x="{x0 + 36}" y="{y1 - 58}" font-size="15" fill="{hexc(INK)}">MarsNav (with the butte\'s own albedo)</text>')
    b.append(f'<rect x="{x0 + 14}" y="{y1 - 44}" width="14" height="14" fill="{hexc(BAD)}"/><text x="{x0 + 36}" y="{y1 - 32}" font-size="15" fill="{hexc(INK)}">Without the butte\'s albedo: a stronger drop at every height</text>')
    open(os.path.join(OUT, "shielding.svg"), "w").write(svg_wrap(W, Hh, "".join(b)))


GALLERY = {  # output name: (source, crop box or None)
    "visor.jpg": (os.path.join(GUIDE, "g15_visor.jpg"), None),
    "rover_dashboard.jpg": (os.path.join(GUIDE, "g16_rover.jpg"), None),
    "cuff.jpg": (os.path.join(GUIDE, "g18_cuff_c0_0_480_1150.jpg"), None),
    "rover_case_study.jpg": (os.path.join(SCREENS, "20_rover_case_study.jpg"), None),
    "landing_globe.jpg": (os.path.join(SCREENS, "13_landing_mode.jpg"), None),
    "landing_dossier.jpg": (os.path.join(SCREENS, "14_landing_dossier.jpg"), None),
    "walkback.jpg": (os.path.join(SCREENS, "03_walkback_field.jpg"), None),
    "leak_return.jpg": (os.path.join(SCREENS, "07_execute_leak_return.jpg"), None),
    "point_of_no_return.jpg": (os.path.join(SCREENS, "10_point_of_no_return.jpg"), None),
    "mount_sharp_3d.jpg": (os.path.join(GUIDE, "g11b_mount_sharp_3d_c330_50_1440_860.jpg"), None),
    "atlas.jpg": (os.path.join(GUIDE, "g06_atlas.jpg"), None),
    "marci_storm.jpg": (os.path.join(GUIDE, "w01_marci_storm.jpg"), None),
    "drive.jpg": (os.path.join(SCREENS, "18_drive_window.jpg"), None),
    "mars_mode.jpg": (os.path.join(SCREENS, "16_local_mode.jpg"), None),
}


def gallery():
    for name, (src, crop) in GALLERY.items():
        im = Image.open(src).convert("RGB")
        if crop:
            im = im.crop(crop)
        im.thumbnail((1400, 1400), Image.LANCZOS)
        im.save(os.path.join(OUT, name), quality=84, optimize=True, progressive=True)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    hero()
    results_chart()
    shielding_chart()
    gallery()
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"wrote {len(os.listdir(OUT))} files to {os.path.relpath(OUT, ROOT)} ({total / 1e6:.1f} MB)")
