"""
build_imagery.py - basemap images for the offline app, all from real USGS products.

    python pipeline/build_imagery.py [--site jezero]

  <out>/ortho5.jpg        site orthoimage (Jezero: CTX mosaic, 5 m) cropped to the operations area, 5 m/px; without an
                          orthoimage, a shaded relief of the 10 m elevation is used instead
  <out>/hi2/{r}_{c}.jpg   1 km x 1 km tiles at 2 m/px: 1 m DTM hillshade (multi-directional) blended with the ortho
                          tone, only where 1 m DTMs exist. Tile index is in <out>/imagery.json.
  <out>/regional.jpg      regional shaded relief from the regional DEM (100 m) for the overview map.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import rasterio
import rasterio.warp
import rasterio.windows
from PIL import Image
from rasterio.warp import reproject, Resampling
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from mars_geo import Grid, crs_wkt  # noqa: E402
from build_terrain import warp_window  # noqa: E402
from sitecfg import cli_site  # noqa: E402
from build_layers import hires_used  # noqa: E402


def hillshade(z, res, az=315.0, alt=35.0):
    gy, gx = np.gradient(z, res)
    sl = np.arctan(np.hypot(gx, gy))
    asp = np.arctan2(-gx, gy)
    a, e = np.radians(az), np.radians(alt)
    return np.clip(np.sin(e) * np.cos(sl) + np.cos(e) * np.sin(sl) * np.cos(a - asp), 0, 1)


def multi_hillshade(z, res):
    return 0.5 * hillshade(z, res, 315) + 0.25 * hillshade(z, res, 270) + 0.25 * hillshade(z, res, 0)


def stretch(a, lo=1, hi=99):
    v = a[np.isfinite(a)]
    p0, p1 = np.percentile(v, lo), np.percentile(v, hi)
    return np.clip((a - p0) / max(p1 - p0, 1e-6), 0, 1)


MARS_TINT = np.array([1.00, 0.80, 0.62])   # warm tint so the greyscale CTX reads as Mars; display only


def load_layer(man, name, out):
    import gzip
    m = man["layers"][name]
    g = man["grids"][m["grid"]]
    z = np.frombuffer(gzip.open(os.path.join(out, m["file"])).read(), dtype=m["dtype"]).astype(np.float32)
    return z.reshape(g["height"], g["width"]) / m["scale"] - m["offset"]


def main(site: dict):
    OUT, RAW, src_cfg = site["out"], site["raw"], site["sources"]
    man = json.load(open(os.path.join(OUT, "manifest.json")))
    g = man["grids"]["ops10"]
    ops = Grid(g["x0"], g["y0"], g["res"], g["width"], g["height"])
    g5 = Grid(ops.x0, ops.y0, 5.0, ops.width * 2, ops.height * 2)
    if src_cfg.get("ortho"):
        with rasterio.open(os.path.join(RAW, src_cfg["ortho"])) as src:
            win = rasterio.windows.from_bounds(*rasterio.warp.transform_bounds(crs_wkt(), src.crs, *g5.bounds),
                                               transform=src.transform).round_offsets().round_lengths()
            win = rasterio.windows.Window(win.col_off - 8, win.row_off - 8, win.width + 16, win.height + 16)
            win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            data = src.read(1, window=win).astype(np.float32)
            o = np.zeros((g5.height, g5.width), np.float32)
            reproject(data, o, src_transform=src.window_transform(win), src_crs=src.crs, src_nodata=0,
                      dst_transform=g5.transform, dst_crs=crs_wkt(), dst_nodata=np.nan, resampling=Resampling.bilinear)
        o[o <= 0] = np.nan
        ortho_src = f"{src_cfg['ortho']} (orthoimage), tinted for display"
    else:
        z = load_layer(man, "elev_dm", OUT)
        o = ndi.zoom(multi_hillshade(z, 10.0), 2, order=1)[: g5.height, : g5.width]
        ortho_src = "shaded relief of the 10 m elevation (no orthoimage for this site)"
    tone = stretch(o)
    tone = np.nan_to_num(tone, nan=0.3)
    rgb = (np.clip(tone[..., None] * MARS_TINT * 255, 0, 255)).astype(np.uint8)
    Image.fromarray(rgb).save(os.path.join(OUT, "ortho5.jpg"), quality=82, optimize=True, progressive=True)
    print("ortho5.jpg", rgb.shape, os.path.getsize(os.path.join(OUT, "ortho5.jpg")) / 1e6, "MB")

    # HiRISE 2 m detail tiles
    os.makedirs(os.path.join(OUT, "hi2"), exist_ok=True)
    tiles = []
    srcs = [rasterio.open(os.path.join(RAW, h["file"])) for h in hires_used(site)]
    TILE_M = 1000
    for r0 in (range(0, ops.height * 10, TILE_M) if srcs else []):
        for c0 in range(0, ops.width * 10, TILE_M):
            g1 = Grid(ops.x0 + c0 - 20, ops.y0 - r0 + 20, 1.0, TILE_M + 40, TILE_M + 40)
            z = np.full((g1.height, g1.width), np.nan, np.float32)
            for s in srcs:
                d = warp_window(s, g1)
                if d is None:
                    continue
                m = np.isnan(z) & np.isfinite(d)
                z[m] = d[m]
            valid = np.isfinite(z)
            if valid.mean() < 0.05:
                continue
            idx = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
            zf = z[tuple(idx)]
            hs = multi_hillshade(zf, 1.0)[20:-20, 20:-20]
            v = valid[20:-20, 20:-20]
            hs2 = hs.reshape(TILE_M // 2, 2, TILE_M // 2, 2).mean((1, 3))
            v2 = v.reshape(TILE_M // 2, 2, TILE_M // 2, 2).mean((1, 3)) > 0.5
            # ortho tone for this tile (5 m -> 2 m)
            rr0, cc0 = r0 // 5, c0 // 5
            t5 = tone[rr0:rr0 + TILE_M // 5, cc0:cc0 + TILE_M // 5]
            if t5.shape != (TILE_M // 5, TILE_M // 5):
                t5 = np.pad(t5, ((0, TILE_M // 5 - t5.shape[0]), (0, TILE_M // 5 - t5.shape[1])), mode="edge")
            t2 = ndi.zoom(t5, 2.5, order=1)[: TILE_M // 2, : TILE_M // 2]
            hsn = hs2.copy()
            if v2.any():
                lo, hi = np.percentile(hs2[v2], [1, 99])
                hsn = np.clip((hs2 - lo) / max(hi - lo, 1e-6), 0, 1)
            lum = np.where(v2, 0.12 + 0.88 * (0.75 * hsn + 0.25 * t2), t2)
            rgb = (np.clip(lum[..., None] * MARS_TINT * 255, 0, 255)).astype(np.uint8)
            alpha = (v2 * 255).astype(np.uint8)
            fn = f"hi2/{r0 // TILE_M}_{c0 // TILE_M}.jpg"
            Image.fromarray(rgb).save(os.path.join(OUT, fn), quality=80, optimize=True)
            tiles.append({"file": fn, "r0": r0 // 10, "c0": c0 // 10, "cells": TILE_M // 10, "px": TILE_M // 2,
                          "valid": round(float(v2.mean()), 3)})
    for s in srcs:
        s.close()
    size_hi = sum(os.path.getsize(os.path.join(OUT, t["file"])) for t in tiles) / 1e6
    print(f"{len(tiles)} HiRISE 2 m tiles, {size_hi:.1f} MB")

    # regional shaded relief
    ze = load_layer(man, "reg_elev_dm", OUT)
    hs = multi_hillshade(ze, 100.0)
    el = stretch(ze, 1, 99)
    lum = 0.25 + 0.75 * (0.7 * hs + 0.3 * el)
    Image.fromarray((np.clip(lum[..., None] * MARS_TINT * 255, 0, 255)).astype(np.uint8)).save(
        os.path.join(OUT, "regional.jpg"), quality=85, optimize=True)
    keys = ", ".join(h["key"] for h in hires_used(site))
    json.dump({"ortho5": {"file": "ortho5.jpg", "res": 5.0, "width": g5.width, "height": g5.height, "source": ortho_src},
               "hi2": {"tiles": tiles, "res": 2.0,
                       "source": f"1 m DTMs ({keys}) hillshade x ortho tone" if keys else "none (no 1 m DTM at this site)"},
               "regional": {"file": "regional.jpg", "grid": "reg100",
                            "source": f"{src_cfg['regional_dem']} averaged to 100 m, shaded relief"}},
              open(os.path.join(OUT, "imagery.json"), "w"), indent=1)


if __name__ == "__main__":
    main(cli_site(__doc__.splitlines()[1]))
