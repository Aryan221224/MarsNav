"""Imagery tiles (256 x 256 JPEG): a base layer, with optional overlays composited on the server.

Base layers
  best          Viking MDIM 2.1 colour (232 m), sharpened with the finest greyscale that exists at the place and zoom:
                HiRISE (25 cm - 1 m, Esri-hosted HiRISE mosaic, then USGS HiRISE orthoimages) from z 14, the CTX global
                mosaic (~5 m, Murray Lab / Caltech, Esri-hosted) from z 8, CTX orthoimages where the mosaic has gaps, or a
                shaded relief of the tile's own measured elevation.
  ctx           CTX global mosaic, 5 m greyscale (NASA/JPL/MSSS/The Murray Lab; beta01 free for all uses with credit)
  themis_day    THEMIS day-time infrared, 100 m (ASU / USGS controlled mosaics via NASA Mars Trek): morphology
  themis_night  THEMIS night-time infrared, 100 m: bright = rock / indurated ground, dark = loose fine material
  viking        Viking MDIM 2.1 colour mosaic, 232 m (NASA Mars Trek)
  mola          MOLA colour shaded relief, 463 m (NASA Mars Trek)
Overlays (ovl=a,b,...; drawn in this order)
  geology       Global geologic map, Tanaka et al. 2014 (USGS SIM 3292, via NASA Mars Trek)
  ti / grs / ice01 / ice15 / ice5 / craters     planet/datasets.py
  safety_<lander>                               planet/safety.py: where this lander can touch down
Every source tile is cached on disk (flight-simulator style rolling cache)."""
from __future__ import annotations

import io
import threading

import numpy as np
from PIL import Image

from . import catalog, cog, dem, net, tilecache
from .config import R_MARS, TILE
from .tiling import bounds, valid

TREK = "https://trek.nasa.gov/tiles/Mars/EQ/{layer}/1.0.0//default/default028mm/{z}/{y}/{x}.{ext}"
TREK_GEOLOGY = ("https://trek.nasa.gov/mars/trekarcgis/rest/services/SIM3292_Global_Geology/MapServer/WMTS/tile/1.0.0/"
                "SIM3292_Global_Geology/default/default028mm/{z}/{y}/{x}.png")
ESRI = "https://astro.arcgis.com/arcgis/rest/services/OnMars/{svc}/MapServer/tile/{z}/{y}/{x}"
LAYERS = {
    "viking": {"layer": "Mars_Viking_MDIM21_ClrMosaic_global_232m", "maxz": 7, "ext": "jpg",
               "name": "Viking MDIM 2.1 colour mosaic, 232 m (NASA Mars Trek / USGS)"},
    "mola": {"layer": "Mars_MGS_MOLA_ClrShade_merge_global_463m", "maxz": 7, "ext": "jpg",
             "name": "MOLA colour shaded relief, 463 m (NASA Mars Trek / USGS)"},
    "hrsc_shade": {"layer": "Mars_MOLA_blend200ppx_HRSC_ClrShade_clon0dd_200mpp_lzw", "maxz": 8, "ext": "jpg",
                   "name": "HRSC + MOLA colour shaded relief, 200 m (ESA Mars Express / NASA MGS; USGS, NASA Mars Trek)"},
    "themis_day": {"layer": "THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018", "maxz": 9, "ext": "png", "grey": True,
                   "name": "THEMIS day-time IR, 100 m (ASU / USGS, NASA Mars Trek)"},
    "themis_night": {"layer": "THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018", "maxz": 9, "ext": "png", "grey": True,
                     "name": "THEMIS night-time IR, 100 m: bright = rocky or indurated, dark = loose fines (ASU / USGS)"},
}
ESRI_SVC = {
    "ctx": {"svc": "CTX1", "maxz": 13, "name": "CTX global mosaic ~5 m (NASA/JPL/MSSS/The Murray Lab, Caltech)"},
    "hirise": {"svc": "HiRISE", "maxz": 17, "name": "HiRISE mosaic 25 cm-1 m (NASA/JPL/University of Arizona/USGS)"},
}
BASES = ("best", "ctx", "themis_day", "themis_night", "viking", "mola", "hrsc_shade")
# drawing order: whole-planet fields first, then outlines, lines and points (planet/features.py), safety_<lander>, and the
# crater rims on top of everything
OVERLAYS = ("geology", "pressure", "gcr", "sunlight", "gravity", "albedo", "dci", "roughness", "tes_plag", "tes_cpx", "tes_glass",
            "ti", "grs", "grs_fe", "grs_cl", "grs_k", "grs_th", "grs_si", "ice01", "ice15", "ice5",
            "f_dunes", "f_chlorides", "f_valleys", "f_fans", "f_glacial", "f_gullies", "f_hydrous", "f_aqueous", "f_active",
            "f_traverses", "f_landers", "craters")
_lock = threading.Lock()


def _fetch_cached(kind: str, z: int, y: int, x: int, url: str, ext: str) -> bytes | None:
    from . import localmode
    lp = localmode.tile_path(kind, z, y, x, ext)          # Local mode copy (never trimmed)
    if lp.exists():
        try:
            return lp.read_bytes()
        except OSError:
            pass
    key = tilecache.path(kind, z, y, x, ext)
    if not key.exists() and net.blocked():
        return None                                      # Mars mode: not on this computer

    def fetch():
        try:
            return net.get(url, timeout=20, retries=1)
        except Exception:  # noqa: BLE001
            return None
    try:
        return tilecache.get_or_build(key, fetch)
    except Exception:  # noqa: BLE001
        return None


def _open(b: bytes | None, mode: str = "RGB") -> Image.Image | None:
    if not b:
        return None
    try:
        return Image.open(io.BytesIO(b)).convert(mode)
    except Exception:  # noqa: BLE001
        return None


def _trek(layer: str, z: int, y: int, x: int) -> Image.Image | None:
    """One Mars Trek tile of a base layer (RGB, or LA for the greyscale THEMIS layers)."""
    L = LAYERS[layer]
    b = _fetch_cached(f"trek_{layer}", z, y, x, TREK.format(layer=L["layer"], z=z, y=y, x=x, ext=L["ext"]), L["ext"])
    return _open(b, "LA" if L.get("grey") else "RGB")


def _from_parent(fetch, maxz: int, z: int, y: int, x: int, size: int = TILE):
    """Tile (z, y, x) from a service that stops at maxz: crop the covering maxz tile and upsample. In Mars mode a tile
    that is not on this computer comes from the nearest coarser level that is (up to 8 levels up)."""
    zz = min(z, maxz)
    floor = max(0, zz - 8) if net.blocked() else zz
    while zz >= floor:
        k = z - zz
        py, px = y >> k, x >> k
        parent = fetch(zz, py, px)
        if parent is not None:
            if k == 0:
                return parent.resize((size, size), Image.LANCZOS) if parent.size[0] != size else parent
            f = 1 << k
            sub = parent.size[0] / f
            oy, ox = (y - (py << k)) * sub, (x - (px << k)) * sub
            return parent.crop((int(ox), int(oy), int(ox + max(1, sub)), int(oy + max(1, sub)))).resize((size, size), Image.BICUBIC)
        zz -= 1
    return None


def _base_trek(layer: str, z: int, y: int, x: int) -> Image.Image | None:
    return _from_parent(lambda zz, yy, xx: _trek(layer, zz, yy, xx), LAYERS[layer]["maxz"], z, y, x)


def _esri_grey(kind: str, z: int, y: int, x: int) -> np.ndarray | None:
    """Greyscale detail from an Esri-hosted Mars mosaic (512 px tiles on the same grid as ours), 0-1 with NaN where the
    mosaic has no data."""
    E = ESRI_SVC[kind]

    def fetch(zz, yy, xx):
        b = _fetch_cached(f"esri_{kind}", zz, yy, xx, ESRI.format(svc=E["svc"], z=zz, y=yy, x=xx), "img")
        return _open(b, "LA")
    im = _from_parent(fetch, E["maxz"], z, y, x)
    if im is None:
        return None
    a = np.asarray(im, np.float32) / 255.0
    g, al = a[..., 0], a[..., 1]
    g = np.where((al > 0.5) & (g > 0.012), g, np.nan)       # transparent or pure black = no image there
    return g if np.isfinite(g).mean() > 0.02 else None


def _hillshade_from_dem(z: int, y: int, x: int, with_meta: bool = False):
    a, m = dem.tile(z, y, x)
    w, s, e, n = m["bbox"]
    N = a.shape[0]
    lat = (s + n) / 2
    dy = (n - s) / (N - 1) * np.pi / 180 * R_MARS
    dx = dy * max(0.02, np.cos(np.radians(lat)))
    a = np.where(np.isfinite(a), a, np.nanmean(a) if np.isfinite(a).any() else 0)
    gy, gx = np.gradient(a, dy, dx)
    gy = -gy                                 # rows run north to south
    sl = np.arctan(np.hypot(gx, gy))
    asp = np.arctan2(-gx, gy)
    hs = 0.0
    for az, wgt in ((315, 0.5), (270, 0.25), (0, 0.25)):
        A, E = np.radians(az), np.radians(40)
        hs = hs + wgt * np.clip(np.sin(E) * np.cos(sl) + np.cos(E) * np.sin(sl) * np.cos(A - asp), 0, 1)
    img = Image.fromarray((np.clip(hs, 0, 1) * 255).astype(np.uint8)).resize((TILE, TILE), Image.BILINEAR)
    out = np.asarray(img, np.float32) / 255.0
    return (out, m) if with_meta else out


def _pansharpen(rgb: np.ndarray, grey: np.ndarray, strength: float = 1.0, replace: bool = True) -> np.ndarray:
    """Keep the colour (chroma) of rgb and take the brightness detail from grey (both float 0-1). replace=True: grey is a
    sharper photograph of the same ground, whose detail replaces the colour image's; replace=False: grey is relief
    shading, whose detail is added on top of the colour image's own."""
    from scipy import ndimage as ndi
    lum = rgb.mean(axis=2)
    g = np.where(np.isfinite(grey), grey, np.nan)
    ok = np.isfinite(g)
    if ok.sum() < 20:
        return rgb
    gf = np.where(ok, g, 0)
    wgt = ndi.gaussian_filter(ok.astype(np.float32), 12) + 1e-6
    gmean = ndi.gaussian_filter(gf, 12) / wgt
    lmean = ndi.gaussian_filter(lum, 12)
    detail = g / np.maximum(gmean, 1e-3)
    ratio = np.where(ok, detail * lmean / np.maximum(lum, 1e-3) if replace else detail, 1.0)
    ratio = 1 + (np.clip(ratio, 0.2, 3.0) - 1) * strength
    return np.clip(rgb * ratio[..., None], 0, 1)


_ortho_failed = threading.local()


def _ortho_grey(kind: str, z: int, y: int, x: int) -> tuple[np.ndarray | None, float]:
    """Greyscale detail from USGS CTX / HiRISE orthoimage COGs (remote reads in a raster worker)."""
    w, s, e, n = bounds(z, y, x)
    got = None
    for it in catalog.query(kind, w, s, e, n, limit=6):
        if not it.get("ortho"):
            continue
        try:
            a = cog.read_lonlat(it["ortho"], w, s, e, n, TILE, TILE, vertex=False, resampling="average" if z < 16 else "bilinear",
                                valid_range=(1e-6, 1e9))
        except net.Offline:
            continue                                     # Mars mode: this orthoimage is not in the local packs
        except Exception:  # noqa: BLE001 - network timeout or error: this tile is built again later
            _ortho_failed.flag = True
            continue
        if a is None:
            continue
        v = np.isfinite(a)
        if v.sum() > 50:
            lo, hi = np.nanpercentile(a[v], [1, 99])
            a = np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1)
        got = a if got is None else np.where(np.isfinite(got), got, a)
    if got is None:
        return None, 0.0
    return got, float(np.isfinite(got).mean())


def _fill(detail, more):
    if more is None:
        return detail
    return more if detail is None else np.where(np.isfinite(detail), detail, more)


def _grey_rgb(a: np.ndarray) -> np.ndarray:
    return np.repeat(np.clip(np.nan_to_num(a, nan=0.0), 0, 1)[..., None], 3, axis=2)


def build(z: int, y: int, x: int, layer: str = "best", ovls: tuple = ()) -> tuple[bytes, dict]:
    if not valid(z, y, x):
        raise ValueError("tile out of range")
    _ortho_failed.flag = False
    used = []
    provisional = False
    rgb = None
    if layer == "ctx":
        g = _esri_grey("ctx", z, y, x)
        if g is not None:
            hs = _hillshade_from_dem(z, y, x)
            rgb = _grey_rgb(np.where(np.isfinite(g), g, 0.35 + 0.5 * hs))
            used.append({"name": ESRI_SVC["ctx"]["name"], "frac": round(float(np.isfinite(g).mean()), 3)})
        else:
            provisional = True
    elif layer in ("themis_day", "themis_night"):
        im = _base_trek(layer, z, y, x)
        if im is not None:
            a = np.asarray(im, np.float32) / 255.0
            rgb = _grey_rgb(np.where(a[..., 1] > 0.5, a[..., 0], np.nan))
            used.append({"name": LAYERS[layer]["name"], "frac": 1.0})
        else:
            provisional = True
    if rgb is None:
        colour_layer = layer if layer in ("mola", "hrsc_shade") else "viking"
        base = _base_trek(colour_layer, z, y, x)
        if base is None:
            hs, dm = _hillshade_from_dem(z, y, x, with_meta=True)
            provisional = True
            rgb = np.stack([hs * 0.95 + 0.05, hs * 0.72 + 0.04, hs * 0.55 + 0.03], axis=2)
            used.append({"name": "shaded relief of the elevation tile (imagery offline)", "frac": 1.0})
        else:
            rgb = np.asarray(base, np.float32) / 255.0
            used.append({"name": LAYERS[colour_layer]["name"], "frac": 1.0})
            if layer == "best" and z >= 8:
                detail = None
                if z >= 14:
                    hr = _esri_grey("hirise", z, y, x)
                    if hr is not None:
                        used.append({"name": ESRI_SVC["hirise"]["name"], "frac": round(float(np.isfinite(hr).mean()), 3)})
                    detail = _fill(detail, hr)
                    if detail is None or np.isnan(detail).mean() > 0.3:
                        h2, f = _ortho_grey("hirise", z, y, x)
                        if h2 is not None:
                            used.append({"name": "HiRISE orthoimage (USGS, 0.25-1 m)", "frac": round(f, 3)})
                        detail = _fill(detail, h2)
                ctx = _esri_grey("ctx", z, y, x)
                if ctx is not None:
                    used.append({"name": ESRI_SVC["ctx"]["name"], "frac": round(float(np.isfinite(ctx).mean()), 3)})
                detail = _fill(detail, ctx)
                if z >= 11 and (detail is None or np.isnan(detail).mean() > 0.2):
                    for k in ("ctx", "hirise"):
                        if not catalog.ready(k):
                            provisional = True
                            catalog.load(k)
                    c2, f = _ortho_grey("ctx", z, y, x)
                    if c2 is not None:
                        used.append({"name": "CTX orthoimage (USGS, 6 m)", "frac": round(f, 3)})
                    detail = _fill(detail, c2)
                hs, dm = _hillshade_from_dem(z, y, x, with_meta=True)
                provisional = provisional or bool(dm.get("provisional"))
                if detail is None:
                    if dm.get("finest_m", 3705) <= 500:
                        used.append({"name": f"relief shading from {dm['finest_m']} m elevation", "frac": 1.0})
                        rgb = _pansharpen(rgb, 0.35 + 0.65 * hs, strength=0.7 if dm["finest_m"] > 100 else 1.0, replace=False)
                else:
                    filled = np.where(np.isfinite(detail), detail, 0.35 + 0.65 * hs)
                    rgb = _pansharpen(rgb, filled, strength=1.0)
    provisional = provisional or bool(getattr(_ortho_failed, "flag", False))
    offline_now = net.blocked()
    # ---- overlays
    from . import atlas, datasets, features
    for ov in ovls:
        if ov == "geology":
            im = _from_parent(lambda zz, yy, xx: _open(_fetch_cached("trek_geology", zz, yy, xx, TREK_GEOLOGY.format(z=zz, y=yy, x=xx), "png"), "RGBA"),
                              11, z, y, x)
            if im is None:
                provisional = True
                continue
            a = np.asarray(im, np.float32) / 255.0
            al = a[..., 3:4] * 0.55
            rgb = rgb * (1 - al) + a[..., :3] * al
            used.append({"name": "Geologic map of Mars, Tanaka et al. 2014 (USGS SIM 3292)", "frac": 1.0})
        elif ov.startswith("safety"):
            from . import safety
            lander = ov.split("_", 1)[1] if "_" in ov else "human"
            a, dm = dem.tile(z, y, x)
            provisional = provisional or bool(dm.get("provisional"))
            px, sinfo = safety.tile_classes(a, dm, lander if lander in safety.LIMITS else "human")
            rgb = safety.overlay(rgb, px, sinfo["verified"])
            used.append({"name": f"landing safety for {lander} at {sinfo['baseline_m']} m", "frac": 1.0})
        elif ov.startswith("f_") or ov in atlas.TREK_OVL or ov in atlas.MODEL_OVL:
            if ov.startswith("f_"):
                w_, s_, e_, n_ = bounds(z, y, x)
                o = features.overlay_rgba(ov, w_, s_, e_, n_, TILE)
                name = (features.legend(ov) or {}).get("title", ov)
            else:
                o = atlas.overlay_rgba(ov, z, y, x, TILE)
                name = (atlas.legend(ov) or {}).get("title", ov)
            if o is None:
                provisional = True
                continue
            al = o[..., 3:4]
            rgb = rgb * (1 - al) + o[..., :3] * al
            used.append({"name": name, "frac": 1.0})
        else:
            o = datasets.overlay_rgba(ov, z, y, x, TILE)
            if o is None:
                provisional = True                     # data not installed yet: never cache the tile without it
                continue
            al = o[..., 3:4]
            rgb = rgb * (1 - al) + o[..., :3] * al
            used.append({"name": datasets.LEGENDS.get(ov, {}).get("title", ov), "frac": 1.0})
    im = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=84, optimize=True)
    if offline_now:
        provisional = False          # Mars mode: built from everything on this computer; it is final (in the offline cache)
    return buf.getvalue(), {"z": z, "y": y, "x": x, "layer": layer, "ovls": list(ovls), "sources": used, "provisional": provisional,
                            "offline": offline_now}


def parse(layer: str, ovl: str = "") -> tuple[str, tuple]:
    """Normalise a request: base layer + ordered overlay list. Old style layer=safety_<lander> still works."""
    from .safety import LIMITS
    ovs = [o for o in (ovl or "").split(",") if o]
    if layer.startswith("safety"):
        ovs.append(layer if "_" in layer else "safety_human")
        layer = "best"
    if layer not in BASES:
        layer = "best"
    clean = [o for o in OVERLAYS if o in ovs and o not in ("craters", "f_traverses", "f_landers")]
    saf = next((o for o in ovs if o.startswith("safety_") and o.split("_", 1)[1] in LIMITS), None)
    if saf:
        clean.append(saf)
    clean += [o for o in ("f_traverses", "f_landers") if o in ovs]  # rover tracks and landers over the safety map
    if "craters" in ovs:
        clean.append("craters")                                     # rims on top of everything
    return layer, tuple(clean)


def tile_bytes_ex(z: int, y: int, x: int, layer: str = "best", ovl: str = "") -> tuple[bytes, bool]:
    """(jpeg, final). A provisional tile (imagery offline, better data still downloading, overlay data not installed) is
    served but not cached."""
    layer, ovls = parse(layer, ovl)
    kind = f"img3_{layer}" + (f"~{'+'.join(ovls)}" if ovls else "")
    key, _off = tilecache.lookup(kind, z, y, x, "jpg")
    if key.exists():
        return tilecache.get_or_build(key, None), True

    def make():
        data, meta = build(z, y, x, layer, ovls)
        if meta["provisional"]:
            raise dem._Provisional(data)
        return data
    try:
        return tilecache.get_or_build(key, make), True
    except dem._Provisional as p:
        return p.data, False


def tile_bytes(z: int, y: int, x: int, layer: str = "best", ovl: str = "") -> bytes:
    return tile_bytes_ex(z, y, x, layer, ovl)[0]
