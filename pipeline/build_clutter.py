"""
build_clutter.py - Sub-metre terrain clutter at 10 m from the 25 cm HiRISE orthomosaic (Jezero).

Why: a rover that drives itself (Perseverance's AutoNav) slows down where its stereo hazard map is cluttered with rocks,
outcrops and ripples. JPL's rover planners judged that clutter from orbital images at 30-60 cm per pixel and routed the
2022 Rapid Traverse around Seitah because of it (Rapid Traverse paper, JPL Robotics 2023). The 1 m elevation models
cannot see rocks of a few decimetres; the 25 cm images can, through the bright/shadow contrast every rock and ripple
casts. This script measures that contrast and writes the share of cluttered ground in each 10 m cell.

Method (fixed in advance, not fitted to rover data):
  1. high-pass the image: pixel minus its 21 x 21 px (5.25 m) mean;
  2. contrast of each 1 m block (4 x 4 px) = RMS of the high-pass / local mean brightness (stretch-independent);
  3. a 1 m block is "cluttered" when its contrast exceeds twice the median contrast over the whole mosaic area;
  4. clutter of a 10 m cell = share of its 100 one-metre blocks that are cluttered (0..1).
Cells the mosaic does not cover are written as 255 (no data); the planner then falls back to the terrain classes.

Source: USGS Astrogeology / JPL Mars 2020 TRN product JEZ_hirise_soc_007_orthoMosaic_25cm_Ortho_blend120.tif
(HiRISE, NASA/JPL/University of Arizona). It is read in place with HTTP range requests; nothing large is stored.
Usage:  python pipeline/build_clutter.py [--workers 8] [--resume]
Writes app/data/clutter.bin.gz and its manifest entry; per-block histograms are cached in data_cache/work/jezero/clutter/.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import sys
import time
from multiprocessing import Pool

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "app", "data")
CACHE = os.path.join(ROOT, "data_cache", "work", "jezero", "clutter")
URL = ("/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/"
       "JEZ_hirise_soc_007_orthoMosaic_25cm_Ortho_blend120.tif")
GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", GDAL_HTTP_MULTIRANGE="YES",
                GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", GDAL_HTTP_MAX_RETRY=5, GDAL_HTTP_RETRY_DELAY=2, GDAL_CACHEMAX=256)
R_MARS = 3396190.0
DEG = math.pi / 180
BLOCK = 50                                   # ops cells per processing block side (500 m)
SUB = 10                                     # 1 m samples per 10 m cell side
HP = 21                                      # high-pass window (px): 5.25 m
BIN0, BINW, NB = -2.5, 0.05, 60              # log10(contrast) histogram bins
CLUTTER_FACTOR = 2.0                         # cluttered = contrast above 2 x the mosaic median
MIN_SAMPLES = 50                             # fewer valid 1 m samples in a cell -> no data


def _grid():
    man = json.load(open(os.path.join(DATA, "manifest.json")))
    g = man["grids"]["ops10"]
    p = man["projection"]
    return man, g, p


def _work(args):
    """Contrast histogram of every 10 m cell in one block of ops cells. Returns (r0, c0, hist[h, w, NB] uint8)."""
    r0, c0 = args
    out = os.path.join(CACHE, f"b_{r0:04d}_{c0:04d}.npy")
    if os.path.exists(out):
        return r0, c0, None
    import rasterio
    from rasterio.windows import Window
    from scipy.ndimage import uniform_filter
    man, g, p = _grid()
    h = min(BLOCK, g["height"] - r0)
    w = min(BLOCK, g["width"] - c0)
    # 1 m sample points of every cell, in the working (equirectangular) projection
    rr, cc = np.meshgrid(np.arange(r0, r0 + h), np.arange(c0, c0 + w), indexing="ij")
    k = (np.arange(SUB) + 0.5) / SUB
    xs = g["x0"] + (cc[..., None, None] + k[None, None, None, :]) * g["res"]
    ys = g["y0"] - (rr[..., None, None] + k[None, None, :, None]) * g["res"]
    xs, ys = np.broadcast_to(xs, (h, w, SUB, SUB)), np.broadcast_to(ys, (h, w, SUB, SUB))
    kx = R_MARS * math.cos(p["lat_ts"] * DEG)
    lon = xs / kx + (p.get("clon", 0.0) or 0.0) * DEG
    lat = ys / R_MARS
    hist = np.zeros((h, w, NB), np.uint8)
    with rasterio.Env(**GDAL_ENV):
        with rasterio.open(URL) as ds:
            # orthographic projection of the mosaic (lat_0, lon_0 from its CRS)
            prm = ds.crs.to_dict()
            lat0, lon0 = prm.get("lat_0", 0.0) * DEG, prm.get("lon_0", 0.0) * DEG
            dl = lon - lon0
            X = R_MARS * np.cos(lat) * np.sin(dl)
            Y = R_MARS * (math.cos(lat0) * np.sin(lat) - math.sin(lat0) * np.cos(lat) * np.cos(dl))
            inv = ~ds.transform
            col, row = inv * (X, Y)
            pad = HP
            cmin, cmax = int(np.floor(col.min())) - pad, int(np.ceil(col.max())) + pad
            rmin, rmax = int(np.floor(row.min())) - pad, int(np.ceil(row.max())) + pad
            cmin, rmin = max(0, cmin), max(0, rmin)
            cmax, rmax = min(ds.width, cmax), min(ds.height, rmax)
            if cmax - cmin < 2 * pad or rmax - rmin < 2 * pad:
                np.save(out, hist)
                return r0, c0, None
            a = ds.read(1, window=Window(cmin, rmin, cmax - cmin, rmax - rmin)).astype(np.float32)
    valid = a > 0
    low = uniform_filter(a, HP, mode="nearest")
    hp = np.where(valid, a - low, 0.0)
    e = uniform_filter(hp * hp, 4, mode="nearest")
    vfrac = uniform_filter(valid.astype(np.float32), HP, mode="nearest")
    contrast = np.sqrt(e) / np.maximum(low, 1.0)
    ok = (vfrac > 0.99) & (low >= 5.0)
    ci = np.rint(col - cmin).astype(np.int64)
    ri = np.rint(row - rmin).astype(np.int64)
    inside = (ci >= 0) & (ri >= 0) & (ci < a.shape[1]) & (ri < a.shape[0])
    ci, ri = np.clip(ci, 0, a.shape[1] - 1), np.clip(ri, 0, a.shape[0] - 1)
    cval = contrast[ri, ci]
    good = inside & ok[ri, ci] & (cval > 0)
    b = np.clip(((np.log10(np.maximum(cval, 1e-6)) - BIN0) / BINW).astype(np.int64), 0, NB - 1)
    cell = (np.arange(h)[:, None] * w + np.arange(w)[None, :])[..., None, None]
    cell = np.broadcast_to(cell, b.shape)
    idx = cell[good] * NB + b[good]
    hist = np.bincount(idx, minlength=h * w * NB).reshape(h, w, NB).astype(np.uint8)
    np.save(out, hist)
    return r0, c0, None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    man, g, p = _grid()
    jobs = [(r, c) for r in range(0, g["height"], BLOCK) for c in range(0, g["width"], BLOCK)]
    todo = [j for j in jobs if not os.path.exists(os.path.join(CACHE, f"b_{j[0]:04d}_{j[1]:04d}.npy"))]
    print(f"{len(jobs)} blocks, {len(todo)} to do, {a.workers} workers", flush=True)
    t0 = time.time()
    with Pool(a.workers) as pool:
        for n, _ in enumerate(pool.imap_unordered(_work, todo), 1):
            if n % 20 == 0 or n == len(todo):
                el = time.time() - t0
                print(f"  {n}/{len(todo)} blocks, {el / 60:.1f} min, eta {el / n * (len(todo) - n) / 60:.1f} min", flush=True)
    # assemble
    H, W = g["height"], g["width"]
    hist = np.zeros((H, W, NB), np.uint8)
    for r, c in jobs:
        blk = np.load(os.path.join(CACHE, f"b_{r:04d}_{c:04d}.npy"))
        hist[r:r + blk.shape[0], c:c + blk.shape[1]] = blk
    tot = hist.reshape(-1, NB).sum(axis=0, dtype=np.int64)
    cdf = np.cumsum(tot) / tot.sum()
    j = int(np.searchsorted(cdf, 0.5))
    lo = cdf[j - 1] if j > 0 else 0.0
    med_log = BIN0 + BINW * (j + (0.5 - lo) / max(1e-12, cdf[j] - lo))       # interpolated median of log10(contrast)
    thr_log = med_log + math.log10(CLUTTER_FACTOR)
    tb = (thr_log - BIN0) / BINW
    jb, frac = int(np.floor(tb)), tb - math.floor(tb)
    n = hist.sum(axis=2, dtype=np.int32)
    above = hist[..., jb + 1:].sum(axis=2, dtype=np.int32) + (1 - frac) * hist[..., jb].astype(np.float32)
    clutter = np.where(n >= MIN_SAMPLES, above / np.maximum(n, 1), np.nan)
    raw = np.where(np.isfinite(clutter), np.clip(np.rint(clutter * 200), 0, 200), 255).astype(np.uint8)
    fn = "clutter.bin.gz"
    with gzip.open(os.path.join(DATA, fn), "wb", compresslevel=9) as f:
        f.write(raw.tobytes())
    cov = float(np.isfinite(clutter).mean())
    man["layers"]["clutter"] = {"file": fn, "dtype": "uint8", "grid": "ops10", "scale": 200.0, "offset": 0.0, "unit": "",
                                "nodata_raw": 255,
                                "desc": "share of 1 m blocks with rock / ripple contrast above 2x the mosaic median (25 cm HiRISE)",
                                "shape": [H, W], "bytes_gz": os.path.getsize(os.path.join(DATA, fn))}
    man.setdefault("stats", {})["clutter"] = {"coverage": cov, "median_contrast": 10 ** med_log, "threshold_contrast": 10 ** thr_log,
                                              "mean": float(np.nanmean(clutter)), "p90": float(np.nanpercentile(clutter, 90)),
                                              "source": URL.replace("/vsicurl/", "")}
    json.dump(man, open(os.path.join(DATA, "manifest.json"), "w"), indent=1, default=float)
    print(json.dumps(man["stats"]["clutter"]), f"{(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
