"""Build a full MarsNav EVA site anywhere on Mars, from the finest real data that exist there, with the same pipeline
that built Jezero (pipeline/build_terrain.py -> build_layers.py -> build_imagery.py):

  regional DEM   CTX 20 m DTMs (USGS, controlled to MOLA) where they exist, else the MOLA-HRSC 200 m blend, else MOLA
                 463/3700 m; merged in the site's own projection (equirectangular, standard parallel and central meridian
                 at the site, so cells are square on the ground and a site straddling 180 deg is one grid)
  check DEM      the 200 m blend, when CTX supplied the regional DEM (an independent comparison, reported)
  1 m DTMs       every HiRISE DTM that overlaps the operations area (clipped from the USGS COGs, full resolution)
  orthoimage     CTX orthoimages (6 m) mosaicked at 5 m; none -> shaded relief of the DEM
  targets        IAU-named features inside the area, plus survey stations picked by the landmark detector
  habitat        where a lander of the chosen class can safely come down (MSL engineering limits; 1 m-verified ground
                 preferred), the way NASA picks a landing target; refine it in the app with a Monte Carlo landing
  climate        the MEDA-fitted climatology with the hydrostatic pressure correction for the site's elevation
Every source, with its coverage of the site, is written into the site's quality note."""
from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone

import numpy as np

from . import catalog, cog, dem, megdr, names
from .config import PATHS, R_MARS


def site_id(lon: float, lat: float) -> str:
    return "g_{:.3f}{}_{:.3f}e".format(abs(lat), "n" if lat >= 0 else "s", lon % 360).replace(".", "p")


def _pipeline():
    import sys
    p = str(PATHS["pipeline"])
    if p not in sys.path:
        sys.path.insert(0, p)
    os.environ["MM_ROOT"] = str(PATHS["root"])
    import mars_geo
    import sitecfg
    return mars_geo, sitecfg


def _write_tif(path, arr, wkt, transform, nodata=np.nan, dtype="float32"):
    import rasterio
    with rasterio.open(path, "w", driver="GTiff", width=arr.shape[1], height=arr.shape[0], count=1, dtype=dtype, crs=wkt,
                       transform=transform, nodata=nodata, tiled=True, blockxsize=256, blockysize=256, compress="deflate",
                       predictor=2 if dtype == "float32" else 1) as dst:
        dst.write(arr.astype(dtype), 1)


def _centre_elev(a) -> float | None:
    h, w = a.shape
    c = a[h // 2 - 2:h // 2 + 3, w // 2 - 2:w // 2 + 3]
    return round(float(np.nanmean(c)), 1) if np.isfinite(c).any() else None


def build(lon: float, lat: float, km: float = 10.0, lander: str = "human", name: str | None = None, log=print,
          hub: list | None = None) -> dict:
    """Returns {ok, id, path} after writing pipeline/sites/<id>.json and running the pipeline."""
    if abs(lat) > 85:
        raise ValueError("EVA sites are built within 85 deg of the equator (the site projection degrades at the poles); "
                         "the planet view and global router cover the poles.")
    lon = ((lon + 180) % 360) - 180
    km = float(min(24.0, max(4.0, km)))
    mars_geo, sitecfg = _pipeline()
    sid = site_id(lon, lat)
    t0 = time.time()
    # ------------------------------------------------------------------ geometry
    half = km * 1000 / 2
    dlat = math.degrees(half / R_MARS)
    dlon = math.degrees(half / (R_MARS * math.cos(math.radians(lat))))
    ops = [lon - dlon, lat - dlat, lon + dlon, lat + dlat]
    reg_half = max(20000.0, 2.5 * half)
    rdlat = math.degrees(reg_half / R_MARS)
    rdlon = math.degrees(reg_half / (R_MARS * math.cos(math.radians(lat))))
    reg = [lon - rdlon, max(-89, lat - rdlat), lon + rdlon, min(89, lat + rdlat)]
    lat_ts = round(lat, 4)
    clon = round(lon, 4)
    mars_geo.set_projection(lat_ts, f"MartianMap_{sid}", clon)
    wkt = mars_geo.crs_wkt()
    raw_root = sitecfg.raw_dir()
    raw_rel = f"gen/{sid}"
    raw = os.path.join(raw_root, raw_rel)
    os.makedirs(raw, exist_ok=True)
    near = names.nearest(lon, lat, k=3)
    label = name or (f"near {near[0]['name']}" if near else f"{abs(lat):.2f}{'N' if lat >= 0 else 'S'} {lon % 360:.2f}E")
    log(f"site {sid} ({label}): {km:.0f} km operations area, regional {2 * reg_half / 1000:.0f} km")
    # ------------------------------------------------------------------ regional DEM (finest available)
    from affine import Affine
    ctx_items = catalog.query("ctx", *reg, limit=40)
    ops_ctx = catalog.query("ctx", *ops, limit=40)
    res = 20.0 if ops_ctx else 100.0
    x0, y1 = mars_geo.lonlat_to_xy(reg[0], reg[3])
    x1, y0 = mars_geo.lonlat_to_xy(reg[2], reg[1])
    x0, y1 = math.floor(x0 / 20) * 20, math.ceil(y1 / 20) * 20
    nx, ny = int(math.ceil((x1 - x0) / res)), int(math.ceil((y1 - y0) / res))
    T = Affine(res, 0, x0, 0, -res, y1)
    log(f"regional grid {nx} x {ny} at {res:.0f} m")
    blend = None
    sources = []
    if dem.blend_usable():
        try:
            blend = cog.read_grid(dem.BLEND_URL, wkt, T, nx, ny)
            if blend is not None:
                sources.append({"name": dem.SOURCES["blend200"]["name"], "frac": round(float(np.isfinite(blend).mean()), 3), "res_m": 200})
                log("MOLA-HRSC 200 m blend read")
        except Exception as e:  # noqa: BLE001
            log(f"blend unavailable ({type(e).__name__}: {e})")
    if blend is None or not np.isfinite(blend).all():
        cols, rows = np.meshgrid(np.arange(nx), np.arange(ny))
        xs = x0 + (cols + 0.5) * res
        ys = y1 - (rows + 0.5) * res
        lo = np.degrees(xs / (R_MARS * math.cos(math.radians(lat_ts)))) + clon
        la = np.degrees(ys / R_MARS)
        lo = ((lo + 180) % 360) - 180
        mo = megdr.sample128(lo, la, allow_download=True) if abs(lat) < 88 else megdr.sample16(lo, la)
        src = "MOLA MEGDR 128 ppd (463 m)" if abs(lat) < 88 else "MOLA MEGDR 16 ppd"
        if blend is None:
            blend = mo
            sources.append({"name": src, "frac": 1.0, "res_m": 463})
        else:
            gap = ~np.isfinite(blend)
            sources.append({"name": src + " (gaps)", "frac": round(float(gap.mean()), 3), "res_m": 463})
            blend[gap] = mo[gap]
    base_res = min(s_["res_m"] for s_ in sources)
    regional = blend.copy()
    ctx_used = []
    if ctx_items:
        acc = np.full(blend.shape, np.nan, np.float32)
        for it in ctx_items[:16]:
            try:
                a = cog.read_grid(it["dtm"], wkt, T, nx, ny)
            except Exception as e:  # noqa: BLE001
                log(f"  CTX {it['id']}: {type(e).__name__}")
                continue
            if a is None:
                continue
            new = np.isfinite(a) & ~np.isfinite(acc)
            if new.any():
                acc[new] = a[new]
                ctx_used.append(it["id"])
                log(f"  CTX DTM {it['id']}: {100 * new.mean():.1f} % of the regional area")
        if ctx_used:
            regional = dem.feather_merge(blend, acc, feather_px=25)
            sources.append({"name": dem.SOURCES["ctx"]["name"], "frac": round(float(np.isfinite(acc).mean()), 3), "res_m": 20,
                            "products": ctx_used})
    _write_tif(os.path.join(raw, "regional_dem.tif"), regional, wkt, T)
    check = None
    if ctx_used:
        _write_tif(os.path.join(raw, "check_blend200.tif"), blend, wkt, T)
        check = f"{raw_rel}/check_blend200.tif"
    # fraction of the operations area covered by 20 m data decides the calibration
    ix0, iy0 = mars_geo.lonlat_to_xy(ops[0], ops[3])
    ix1, iy1 = mars_geo.lonlat_to_xy(ops[2], ops[1])
    c0, c1 = int((ix0 - x0) / res), int((ix1 - x0) / res)
    r0, r1 = int((y1 - iy0) / res), int((y1 - iy1) / res)
    ops_ctx_frac = 0.0
    if ctx_used:
        sub = np.isfinite(acc[max(0, r0):r1, max(0, c0):c1])
        ops_ctx_frac = float(sub.mean()) if sub.size else 0.0
    dem_res = 20.0 if ops_ctx_frac > 0.6 else float(base_res)
    # ------------------------------------------------------------------ HiRISE 1 m DTMs over the operations area
    hires = []
    # up to 8 HiRISE 1 m DTMs, the ones covering most of the operations area (and the hub) first
    cands = catalog.query("hirise", *ops, limit=60)
    hx, hy = (hub if hub else (lon, lat))

    def overlap(it):
        bw, bs, be, bn = it["bbox"]
        ov = max(0.0, min(be, ops[2]) - max(bw, ops[0])) * max(0.0, min(bn, ops[3]) - max(bs, ops[1]))
        return (bw <= hx <= be and bs <= hy <= bn, ov)
    cands.sort(key=overlap, reverse=True)
    for it in cands[:8]:
        fn = f"{raw_rel}/hirise_{it['id']}.tif"
        try:
            got = cog.clip_to_file(it["dtm"], os.path.join(raw_root, fn), *ops, pad_deg=0.002)
        except Exception as e:  # noqa: BLE001
            log(f"  HiRISE {it['id']}: {type(e).__name__}: {e}")
            continue
        if got:
            hires.append({"key": it["id"], "file": fn, "optional": True, "quality": 1.0, "source": it["dtm"]})
            log(f"  HiRISE DTM {it['id']}: {got['width']} x {got['height']} at {got['res']:.2f} m")
    # ------------------------------------------------------------------ orthoimage at 5 m over the operations area
    ortho = None
    ocx0, ocy1 = math.floor(ix0 / 5) * 5 - 100, math.ceil(iy0 / 5) * 5 + 100
    onx, ony = int(math.ceil((ix1 - ocx0) / 5)) + 40, int(math.ceil((ocy1 - iy1) / 5)) + 40
    OT = Affine(5.0, 0, ocx0, 0, -5.0, ocy1)
    omos = np.full((ony, onx), np.nan, np.float32)
    for it in ops_ctx[:12]:
        if not it.get("ortho"):
            continue
        try:
            a = cog.read_grid(it["ortho"], wkt, OT, onx, ony, valid_range=(1e-6, 1e9))
        except Exception as e:  # noqa: BLE001
            log(f"  CTX ortho {it['id']}: {type(e).__name__}")
            continue
        if a is None:
            continue
        v = np.isfinite(a)
        lo_, hi_ = np.nanpercentile(a[v], [1, 99])
        a = np.clip((a - lo_) / max(hi_ - lo_, 1e-6), 0, 1) * 254 + 1
        new = v & ~np.isfinite(omos)
        omos[new] = a[new]
    if np.isfinite(omos).mean() > 0.2:
        _write_tif(os.path.join(raw, "ortho_ctx5.tif"), np.nan_to_num(omos, nan=0).astype(np.uint8), wkt, OT, nodata=0, dtype="uint8")
        ortho = f"{raw_rel}/ortho_ctx5.tif"
        sources.append({"name": "CTX orthoimage mosaic (6 m, resampled to 5 m)", "frac": round(float(np.isfinite(omos).mean()), 3), "res_m": 6})
    # ------------------------------------------------------------------ targets: named features in the area
    targets = []
    for f in names.inside(*ops)[:12]:
        targets.append({"id": "N" + str(len(targets) + 1), "name": f"{f['name']} ({f['type'] or 'named feature'})", "kind": "science",
                        "lon": f["lon"], "lat": f["lat"], "value": 0.5, "dwell_min": 30, "sigma_m": 200,
                        "why": f"IAU-named {f['type'] or 'feature'}" + (f", {f['diameter_km']:.1f} km" if f["diameter_km"] else ""),
                        "source": names.CITATION})
    from .landing import LANDERS
    L = LANDERS.get(lander, LANDERS["human"])
    note = "; ".join(f"{s_['name']}: {100 * s_['frac']:.0f} %" for s_ in sources)
    if hires:
        note += f"; HiRISE 1 m DTMs: {', '.join(h['key'] for h in hires)}"
    if dem_res > 30:
        note += (f". Operations area DEM is {dem_res:.0f} m: walking-scale slopes use a calibration from Jezero's 1 m data "
                 "degraded to this resolution; boulders and scarps smaller than the DEM are not in the map (low confidence)")
    cfg = {
        "id": sid, "name": f"{label} ({abs(lat):.3f}{'N' if lat >= 0 else 'S'}, {lon % 360:.3f}E)", "short": label[:40],
        "description": f"Generated by MarsNav from real data: {note}.",
        "generated": {"utc": datetime.now(timezone.utc).isoformat(timespec="seconds"), "lon": lon, "lat": lat, "km": km,
                      "elev_m": _centre_elev(regional),
                      "sources": sources, "hirise": [h["key"] for h in hires], "ctx": ctx_used},
        "projection": {"name": f"MartianMap_{sid}", "lat_ts": lat_ts, "clon": clon, "note": "equirectangular, site-centred"},
        "snap_origin": [float(x0), float(y1)], "crater_center": [lon, lat],
        # the hub the user picked on the planet (landing-screened there); None: the pipeline picks lander-safe ground
        "base": {"id": "HAB", "name": f"Hub ({L['label'].split(' (')[0]} landing site)", "lon": float(hub[0]), "lat": float(hub[1])} if hub else None,
        "ops_area": [round(v, 6) for v in ops], "regional_area": [round(v, 6) for v in reg],
        "clock": {"name": "Site", "landing_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "lon_east": lon,
                  "note": "sol 0 = the day this site was built"},
        "sources": {"regional_dem": f"{raw_rel}/regional_dem.tif", "check_dem": check, "hires_dtms": hires, "ortho": ortho,
                    "traverse": None, "climate": "from:jezero"},
        "calibration_from": "jezero", "dem_res_m": dem_res, "landing": {"lander": lander, "label": L["label"]},
        "out_dir": f"sites/{sid}", "targets": targets, "keepouts": [], "quality_note": note,
    }
    sites_dir = PATHS["pipeline"] / "sites"
    (sites_dir / f"{sid}.json").write_text(json.dumps(cfg, indent=1))
    log("site file written; running the terrain pipeline")
    import build_terrain
    import build_layers
    import build_imagery
    build_terrain.main(sitecfg.load_site(sid))
    log("terrain statistics done; building the planning layers")
    build_layers.main(sitecfg.load_site(sid))
    log("layers done; building imagery")
    build_imagery.main(sitecfg.load_site(sid))
    log(f"site {sid} built in {time.time() - t0:.0f} s")
    return {"ok": True, "id": sid, "name": cfg["name"], "path": f"sites/{sid}/", "sources": sources, "dem_res_m": dem_res,
            "hirise": [h["key"] for h in hires], "ctx": ctx_used}
