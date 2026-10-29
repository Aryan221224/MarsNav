"""The whole-Mars science atlas: one catalogue of every map layer MarsNav can show, grouped by the kind of measurement
(optical, topographic, thermal, spectral, chemical, geophysical, atmospheric, radiation), and the layers that are not
already served by planet/datasets.py or planet/features.py:

  Spectral rasters (NASA Mars Trek tiles, the published colour maps)
    tes_plag     TES plagioclase abundance (Bandfield 2002)
    tes_cpx      TES high-calcium pyroxene abundance (Bandfield 2002)
    tes_glass    TES sheet silicates / high-silica glass (Bandfield 2002)
    dci          TES dust cover index (Ruff & Christensen 2002)
    roughness    MOLA kilometre-scale roughness, 0.6 / 2.4 / 9.2 km baselines as blue / green / red (Kreslavsky & Head 2000)
  Model layers (computed from MOLA elevation and published relations; nothing to download)
    pressure     mean surface pressure: 610 Pa at the datum, 11.1 km scale height (the dossier's own relation)
    gcr          galactic cosmic-ray dose rate at the surface: Curiosity RAD at Gale scaled by the air column overhead with
                 the measured dose-pressure coefficient kappa(Phi) = -(0.28 - 2.9e-4 Phi) uGy/day/Pa (Guo et al., JGR Planets,
                 doi:10.1002/2016JE005206, arXiv:1712.06987)
    sunlight     daily-mean sunlight at the surface over a Mars year (Kepler orbit, obliquity 25.19 deg, dust tau 0.5)
The radiation model is honest about where it holds: RAD measured it between about 700 and 950 Pa; outside that the
value is an extrapolation, and the legend says so."""
from __future__ import annotations

import math

import numpy as np

TREK = "https://trek.nasa.gov/tiles/Mars/EQ/{layer}/1.0.0//default/default028mm/{z}/{y}/{x}.png"
RAINBOW = [(0.0, (90, 0, 200, 0.62)), (0.25, (40, 90, 255, 0.62)), (0.5, (40, 220, 200, 0.62)), (0.7, (120, 230, 60, 0.62)),
           (0.85, (250, 220, 40, 0.62)), (1.0, (240, 40, 30, 0.62))]
TREK_OVL = {
    "tes_plag": {"layer": "TES_Plagioclase", "maxz": 1, "title": "Plagioclase feldspar (TES)",
                 "note": "Relative abundance, 4 px/deg (16 km). Low-albedo regions 0.10-0.20, highest in Syrtis Major; bright dusty "
                         "regions 0-0.05 (below detection). Bandfield J.L. 2002, JGR 107, E6, 5042."},
    "tes_cpx": {"layer": "TES_Clinopyroxene", "maxz": 1, "title": "High-calcium pyroxene (TES)",
                "note": "Relative abundance, 4 px/deg. 0.10-0.20 in equatorial dark regions (Syrtis Major highest); unaltered "
                        "volcanic rock. Bandfield J.L. 2002, JGR 107, E6, 5042."},
    "tes_glass": {"layer": "TES_Glass_Clay", "maxz": 1, "title": "Sheet silicates / high-Si glass (TES)",
                  "note": "Relative abundance, 4 px/deg: 0.05-0.20 in the northern dark plains (weathered or glassy rock). "
                          "Bandfield J.L. 2002, JGR 107, E6, 5042."},
    "dci": {"layer": "tes_ruffdust", "maxz": 1, "title": "Dust cover (TES dust cover index)",
            "note": "16 px/deg (3.5 km). Red: thick dust (Tharsis, Arabia, Elysium) that hides the rock beneath and coats suits "
                    "and panels; blue: dust-free surfaces where orbital spectra see the rock. Ruff S.W. & Christensen P.R. 2002, "
                    "JGR 107, E12, 5127."},
    "roughness": {"layer": "mola_roughness", "maxz": 1, "rgb": True, "title": "Surface roughness (MOLA)",
                  "note": "Kilometre-scale roughness as colour: blue 0.6 km, green 2.4 km, red 9.2 km baselines; brighter is "
                          "rougher. Smooth (dark) plains suit landers and long traverses. Kreslavsky M.A. & Head J.W. 2000, "
                          "JGR 105, 26695."},
}
MODEL_OVL = ("pressure", "gcr", "sunlight")

# Curiosity RAD at Gale (Hassler et al. 2014, Science 343): absorbed dose 0.210 mGy/day, dose equivalent 0.64 mSv/day,
# Bradbury Landing at MOLA -4501 m. Dose-pressure coefficient from RAD over 2012-2016 (Guo et al., doi:10.1002/2016JE005206).
RAD_GALE_UGY = 210.0
RAD_GALE_Q = 0.64 / 0.210
GALE_ELEV_M = -4501.0
KAPPA_C0, KAPPA_C1 = 0.28, -2.9e-4               # -kappa = c0 + c1 * Phi  [uGy/day/Pa]
PHI_DEFAULT = 600.0                              # MV, solar modulation potential at Mars (RAD era 400-700 MV)


def pressure_pa(elev_m):
    """Mean surface pressure from elevation: 610 Pa at the MOLA datum, 11.1 km scale height (as in planet/assess.py)."""
    return 610.0 * np.exp(-np.asarray(elev_m, np.float64) / 11100.0)


def gcr_dose(elev_m, phi_mv: float = PHI_DEFAULT) -> dict:
    """Galactic cosmic-ray surface dose rate at an elevation: Curiosity's RAD value at Gale, moved by the measured
    dose-pressure slope for the air column difference. Returns uGy/day, mSv/day and whether it is extrapolated."""
    kappa = -(KAPPA_C0 + KAPPA_C1 * phi_mv)                 # uGy/day/Pa (negative: more air, less dose)
    p = pressure_pa(elev_m)
    p_gale = float(pressure_pa(GALE_ELEV_M))
    d = RAD_GALE_UGY + kappa * (p - p_gale)
    d = np.maximum(d, 0.0)
    out = {"ugy_day": d, "msv_day": d * RAD_GALE_Q / 1000.0, "pressure_pa": p, "kappa": kappa}
    out["extrapolated"] = (p < 600) | (p > 1100)
    return out


def _insolation_lat(lat_deg: float) -> float:
    from .assess import insolation
    return insolation(lat_deg)["mean_wm2"] * 0.65          # surface at dust tau 0.5 [ASSUME], as in the dossier


_sun_cache: dict = {}


def sunlight(lat):
    lat = np.asarray(lat, np.float64)
    key = np.round(lat * 2) / 2
    out = np.empty_like(lat)
    for v in np.unique(key):
        if v not in _sun_cache:
            _sun_cache[v] = _insolation_lat(float(v))
        out[key == v] = _sun_cache[v]
    return out


PRESS_STOPS = [(300, (120, 0, 120, 0.55)), (500, (200, 60, 90, 0.5)), (700, (240, 170, 80, 0.45)), (900, (120, 200, 230, 0.5)),
               (1150, (30, 80, 200, 0.6))]
GCR_STOPS = [(170, (40, 140, 90, 0.55)), (200, (170, 210, 80, 0.5)), (230, (250, 200, 60, 0.5)), (260, (240, 110, 40, 0.55)),
             (290, (200, 20, 30, 0.62))]
SUN_STOPS = [(40, (30, 30, 80, 0.6)), (70, (90, 60, 150, 0.5)), (100, (200, 90, 80, 0.45)), (120, (250, 180, 60, 0.45)),
             (140, (255, 240, 150, 0.5))]
LEGENDS = {
    "pressure": {"title": "Surface air pressure (model, Pa)", "stops": PRESS_STOPS, "fmt": "{:.0f}", "ticks": [300, 500, 700, 900, 1150],
                 "note": "From MOLA elevation: 610 Pa at the datum, 11.1 km scale height; real pressure swings ~25 % with the season. "
                         "More air: slower entry, more shielding, better aerobraking."},
    "gcr": {"title": "Cosmic-ray dose rate at the surface (model, uGy/day)", "stops": GCR_STOPS, "fmt": "{:.0f}", "ticks": [170, 200, 230, 260, 290],
            "note": "Curiosity RAD at Gale (210 uGy/day, 0.64 mSv/day; Hassler et al. 2014) moved by the measured dose-pressure slope "
                    "(Guo et al., doi:10.1002/2016JE005206) at solar modulation 600 MV. Measured between ~700 and 950 Pa: high ground and deep basins are "
                    "extrapolations. Solar particle events come on top (see Space weather)."},
    "sunlight": {"title": "Daily-mean sunlight at the surface (W/m2)", "stops": SUN_STOPS, "fmt": "{:.0f}", "ticks": [40, 70, 100, 120, 140],
                 "note": "Averaged over a Mars year (Kepler orbit, obliquity 25.19 deg) at dust optical depth 0.5. Sizes solar power."},
}


def legend(ovl: str) -> dict | None:
    from .datasets import _ramp
    if ovl in TREK_OVL:
        T = TREK_OVL[ovl]
        if T.get("rgb"):
            return {"title": T["title"], "note": T["note"]}
        ticks = [{"v": v, "label": lab, "rgba": [float(c) for c in _ramp(np.array([v], np.float32), RAINBOW)[0]]}
                 for v, lab in ((0.0, "low"), (0.25, ""), (0.5, ""), (0.75, ""), (1.0, "high"))]
        return {"title": T["title"], "note": T["note"], "ticks": ticks}
    L = LEGENDS.get(ovl)
    if not L:
        return None
    return {"title": L["title"], "note": L["note"],
            "ticks": [{"v": t, "label": L["fmt"].format(t), "rgba": [float(c) for c in _ramp(np.array([t], np.float32), L["stops"])[0]]}
                      for t in L["ticks"]]}


def overlay_rgba(ovl: str, z: int, y: int, x: int, size: int = 256):
    """(size, size, 4) float RGBA, or None when the source tile cannot be had (offline and not in the local packs)."""
    from .datasets import _ramp
    from .tiling import bounds
    if ovl in TREK_OVL:
        from .imagery import _fetch_cached, _from_parent, _open
        T = TREK_OVL[ovl]
        im = _from_parent(lambda zz, yy, xx: _open(_fetch_cached(f"trek_{T['layer']}", zz, yy, xx,
                                                                  TREK.format(layer=T["layer"], z=zz, y=yy, x=xx), "png"), "RGBA"),
                          T["maxz"], z, y, x, size)
        if im is None:
            return None
        a = np.asarray(im, np.float32) / 255.0
        a[..., 3] = np.where(a[..., 3] > 0.5, 0.62, 0.0)        # the published colours, at a fixed see-through strength
        return a
    if ovl not in MODEL_OVL:
        return None
    w, s, e, n = bounds(z, y, x)
    k = 64                                                     # model fields are smooth: compute coarse, then upsample
    lons = w + (np.arange(k) + 0.5) * (e - w) / k
    lats = n - (np.arange(k) + 0.5) * (n - s) / k
    LO, LA = np.meshgrid(lons, lats)
    if ovl == "sunlight":
        v = sunlight(LA)
        rgba = _ramp(v, SUN_STOPS)
    else:
        from . import megdr
        try:
            el = megdr.sample16(LO.ravel(), LA.ravel()).reshape(LO.shape)
        except Exception:  # noqa: BLE001 - MOLA base not downloaded yet
            return None
        if ovl == "pressure":
            rgba = _ramp(pressure_pa(el), PRESS_STOPS)
        else:
            rgba = _ramp(gcr_dose(el)["ugy_day"], GCR_STOPS)
    from PIL import Image
    chans = [np.asarray(Image.fromarray((rgba[..., c] * 255).astype(np.uint8)).resize((size, size), Image.BILINEAR), np.float32) / 255
             for c in range(4)]
    return np.stack(chans, axis=2)


HUE_LOW = 263.0                                  # the purple at the bottom of Trek's rainbow scales (80, 0, 209)
WORDS = ((0.2, "very low"), (0.4, "low"), (0.6, "moderate"), (0.8, "high"), (1.01, "very high"))


def _word(v: float) -> str:
    return next(w for t, w in WORDS if v < t)


def sample_trek(ovl: str, lon: float, lat: float) -> dict | None:
    """The value of one Trek colour map at a place, read back from its published colours (3 x 3 pixels of the 0.35 deg
    level). The rainbow maps (TES minerals, dust cover) run purple-blue-green-yellow-red from low to high, under a hillshade
    that changes brightness but not hue: the hue gives the position on the scale, 0 to 1. Black, grey and transparent
    pixels are no data. Roughness is an RGB composite: each channel is the roughness at one baseline, 0 to 1."""
    import colorsys

    from .imagery import _fetch_cached, _open
    T = TREK_OVL.get(ovl)
    if not T:
        return None
    z = T["maxz"]
    d = 180.0 / (1 << z)
    lon = ((lon + 180.0) % 360.0) - 180.0
    x, y = int((lon + 180.0) // d), int(min(179.9999, 90.0 - lat) // d)
    im = _open(_fetch_cached(f"trek_{T['layer']}", z, y, x, TREK.format(layer=T["layer"], z=z, y=y, x=x), "png"), "RGBA")
    if im is None:
        return None
    a = np.asarray(im, np.float32) / 255.0
    n = a.shape[0]
    c = int((lon + 180.0 - x * d) / d * n)
    r = int((90.0 - lat - y * d) / d * n)
    win = a[max(0, r - 1):r + 2, max(0, c - 1):c + 2].reshape(-1, 4)
    win = win[win[:, 3] > 0.5]
    if T.get("rgb"):
        win = win[win[:, :3].min(axis=1) < 0.98]              # white: no data (the poles)
        if not len(win):
            return None
        rgb = win[:, :3].mean(axis=0)
        return {"km_0_6": round(float(rgb[2]), 2), "km_2_4": round(float(rgb[1]), 2), "km_9_2": round(float(rgb[0]), 2),
                "word": _word(float(rgb.mean())), "title": T["title"], "relative": True}
    vals = []
    for p in win:
        h, s, v = colorsys.rgb_to_hsv(*map(float, p[:3]))
        if v < 0.15 or s < 0.3:
            continue
        h *= 360.0
        vals.append(1.0 if h > 300 else max(0.0, min(1.0, (HUE_LOW - h) / HUE_LOW)))
    if not vals:
        return None
    v = float(np.median(vals))
    return {"rel": round(v, 2), "word": _word(v), "title": T["title"], "relative": True}


def point(lon: float, lat: float, elev_m: float | None) -> dict:
    """Model values at one place (for the dossier)."""
    out = {"sunlight_wm2": round(float(sunlight(np.array([lat]))[0]), 1)}
    if elev_m is not None and math.isfinite(elev_m):
        g = gcr_dose(np.array([elev_m]))
        out.update({"pressure_pa": round(float(g["pressure_pa"][0])), "gcr_ugy_day": round(float(g["ugy_day"][0]), 1),
                    "gcr_msv_day": round(float(g["msv_day"][0]), 3), "gcr_extrapolated": bool(g["extrapolated"][0]),
                    "gcr_vs_gale": round(float(g["ugy_day"][0] / RAD_GALE_UGY), 3)})
    return out


# ------------------------------------------------------------------ the catalogue the app shows

def catalogue() -> dict:
    """Every layer, grouped by the kind of measurement, with what it needs installed (None: works at once)."""
    from . import datasets, features
    F = features.summary()["layers"] if features.available() else {}
    D = datasets.REGISTRY

    def f(fid, needs=None):
        L = F.get(fid, {})
        return {"id": f"f_{fid}", "name": L.get("name", fid), "what": L.get("what"), "cite": L.get("cite"), "count": L.get("count"),
                "needs": needs, "source": L.get("instruments")}

    def t(tid):
        T = TREK_OVL[tid]
        return {"id": tid, "name": T["title"], "what": T["note"].split(". ")[0], "cite": T["note"], "needs": None, "source": "NASA Mars Trek"}

    def d(oid, did, name):
        return {"id": oid, "name": name, "what": D[did]["what"], "cite": D[did]["cite"], "needs": did, "source": D[did]["res"]}

    def m(mid, name, what):
        return {"id": mid, "name": name, "what": what, "cite": LEGENDS[mid]["note"], "needs": None, "source": "model"}

    groups = [
        {"id": "spectral", "name": "Spectral: minerals", "layers": [
            f("aqueous"), f("hydrous"), f("chlorides"), t("tes_plag"), t("tes_cpx"), t("tes_glass")]},
        {"id": "chemical", "name": "Chemical: elements (Mars Odyssey GRS)", "layers": [
            d("grs", "grs", "Water-equivalent hydrogen (H2O)")] + [d(f"grs_{e}", "grs_el", f"{nm} ({u})") for e, (nm, u) in datasets.GRS_ELEMENTS.items()]},
        {"id": "water", "name": "Water and ice", "layers": [
            d("ice", "swim", "Subsurface water ice (SWIM)"), f("glacial"), f("gullies"), f("valleys"), f("fans")]},
        {"id": "thermal", "name": "Thermal and surface", "layers": [
            d("ti", "ti", "Thermal inertia (TES)"), d("albedo", "albedo", "Albedo (TES)"), t("dci"), f("dunes")]},
        {"id": "topographic", "name": "Topographic and geologic", "layers": [
            t("roughness"), {"id": "geology", "name": "Geologic map (USGS SIM 3292)", "what": "Map units of the whole planet",
                             "cite": "Tanaka K.L. et al. 2014, USGS SIM 3292", "needs": None, "source": "NASA Mars Trek"},
            d("craters", "craters", "Craters >= 1 km")]},
        {"id": "geophysical", "name": "Geophysical", "layers": [d("gravity", "gravity", "Gravity anomaly (MRO GMM-3)")]},
        {"id": "atmospheric", "name": "Atmospheric, radiation and power", "layers": [
            m("pressure", "Surface air pressure", "Mean air pressure from elevation"),
            m("gcr", "Cosmic-ray dose rate", "Galactic cosmic-ray dose at the surface, from Curiosity RAD and the air column"),
            m("sunlight", "Sunlight for solar power", "Daily-mean sunlight over a Mars year")]},
        {"id": "activity", "name": "Present-day activity and planetary protection", "layers": [f("active")]},
        {"id": "missions", "name": "Missions on the ground", "layers": [f("traverses"), f("landers")]},
    ]
    return {"groups": groups, "features_built": features.summary().get("built") if features.available() else None}
