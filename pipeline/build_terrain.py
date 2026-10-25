"""
build_terrain.py - turn real elevation models of a site into terrain statistics on the planning grids.

    python pipeline/build_terrain.py [--site jezero]

Inputs come from the site file (pipeline/sites/<id>.json) and live in data_cache/raw (canonical URLs and SHA-256 in
pipeline/sources.json, downloaded by pipeline/fetch_data.py). For Jezero:
  M20_JezeroCrater_CTXDEM_20m.tif                        JPL/USGS CTX DEM mosaic, 20 m, whole crater (regional_dem)
  JEZ_ctx_B_soc_008_DTM_..._20m.tif                      USGS TRN CTX DTM, 20 m (independent processing; check_dem)
  DTM_..._Jezero_{C,W,CR_SOUTH,CR_NORTH}_..._1m.tif      USGS HiRISE stereo DTMs, 1 m post spacing (hires_dtms)
A site with only a regional DEM is valid: every 1 m statistic is then left empty and build_layers.py falls back to
the calibrated CTX estimates (flagged as low confidence).

Every HiRISE DTM is processed on its own (so each product's noise level can be measured and removed), in 1 m chunks
aligned to the 10 m operations grid; statistics are then merged in priority order (edited in-ellipse DTMs first).

Per 10 m cell, from the 1 m posts (walking scale):
  z_mean, cover            block-mean elevation; fraction of the cell with valid 1 m posts
  sw_p90, sw_max           90th percentile / max of the walking-scale slope (1 m DTM smoothed sigma 1.5 m => ~4 m baseline)
  gt20, gt25, gt30         fraction of the cell steeper than 20 / 25 / 30 deg at walking scale
  step_p99                 99th percentile of |detrended relief| (m) - ledges, scarps, the largest blocks
  bed_E                    RMS of band-passed relief (6-30 m wavelengths) over a 12 m window, tile noise removed in quadrature
  bed_C                    orientation coherence of that relief (0..1): aeolian ripples are strongly directional
  rough                    RMS relief after removing a 10 m trend, tile noise removed in quadrature
Noise model: each DTM's noise floor = 10th percentile of its bed_E / rough over gentle (<5 deg) terrain.
"""
from __future__ import annotations

import json
import os
import sys
import time

import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.windows import from_bounds, Window
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from mars_geo import Grid, grid_from_lonlat, crs_wkt  # noqa: E402
from sitecfg import cli_site  # noqa: E402

F = 10            # 1 m posts per 10 m cell
CELLS = 100       # 10 m cells per chunk side (1 km chunks)
HALO = 48         # m halo so every filter is valid inside the chunk
STATS = ["z_mean", "cover", "sw_p90", "sw_max", "gt20", "gt25", "gt30", "step_p99", "bed_E", "bed_C", "rough"]


def read_to_grid(path: str, grid: Grid, resampling=Resampling.bilinear) -> np.ndarray:
    with rasterio.open(path) as src:
        out = np.full((grid.height, grid.width), np.nan, np.float32)
        data = src.read(1).astype(np.float32)
        bad = ~np.isfinite(data) | (data < -1e4) | (data > 1e4)
        if src.nodata is not None:
            bad |= data == src.nodata
        data[bad] = np.nan
        reproject(data, out, src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
                  dst_transform=grid.transform, dst_crs=crs_wkt(), dst_nodata=np.nan, resampling=resampling)
    return out


def warp_window(src, g1: Grid):
    """Read the part of `src` under the Jezero-projection grid g1, bilinearly resampled onto g1 (NaN outside)."""
    l, b, r, t = transform_bounds(crs_wkt(), src.crs, *g1.bounds)
    sl, sb, sr, st = src.bounds
    if r < sl or l > sr or t < sb or b > st:
        return None
    win = from_bounds(l, b, r, t, transform=src.transform).round_offsets().round_lengths()
    win = Window(win.col_off - 2, win.row_off - 2, win.width + 4, win.height + 4)
    data = src.read(1, window=win, boundless=True, fill_value=src.nodata if src.nodata is not None else -32768)
    data = data.astype(np.float32)
    data[(data < -1e4) | (data > 1e4) | ~np.isfinite(data)] = np.nan
    if not np.isfinite(data).any():
        return None
    out = np.full((g1.height, g1.width), np.nan, np.float32)
    reproject(data, out, src_transform=src.window_transform(win), src_crs=src.crs, src_nodata=np.nan,
              dst_transform=g1.transform, dst_crs=crs_wkt(), dst_nodata=np.nan, resampling=Resampling.bilinear)
    return out


def slope_deg(z: np.ndarray, res: float) -> np.ndarray:
    gy, gx = np.gradient(z, res)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def blocks(a: np.ndarray, f: int) -> np.ndarray:
    h, w = a.shape[0] // f, a.shape[1] // f
    return a[: h * f, : w * f].reshape(h, f, w, f).transpose(0, 2, 1, 3).reshape(h, w, f * f)


def fill_nearest(z: np.ndarray, valid: np.ndarray) -> np.ndarray:
    if valid.all():
        return z
    idx = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    return z[tuple(idx)]


def post_fields(z: np.ndarray, valid: np.ndarray) -> dict:
    """Walking-scale 1 m fields on a chunk (with halo)."""
    zf = fill_nearest(z, valid)
    sw = slope_deg(ndi.gaussian_filter(zf, 1.5), 1.0)
    relief = zf - ndi.gaussian_filter(zf, 3.0)
    rough = zf - ndi.gaussian_filter(zf, 10.0)
    bp = ndi.gaussian_filter(zf, 1.5) - ndi.gaussian_filter(zf, 8.0)
    gy, gx = np.gradient(bp)
    s = 12.0
    jxx, jyy, jxy = (ndi.gaussian_filter(v, s) for v in (gx * gx, gy * gy, gx * gy))
    tr = jxx + jyy
    coh = np.where(tr > 1e-12, np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / np.maximum(tr, 1e-12), 0.0)
    energy = np.sqrt(ndi.gaussian_filter(bp * bp, s))
    return {"sw": sw, "relief": relief, "rough": rough, "coh": coh, "energy": energy}


def process_tile(key: str, path: str, grid: Grid) -> dict:
    out = {n: np.full((grid.height, grid.width), np.nan, np.float32) for n in STATS}
    out["cover"][:] = 0
    t0 = time.time()
    with rasterio.open(path) as src:
        tb = transform_bounds(src.crs, crs_wkt(), *src.bounds)
        c_lo = max(0, int((tb[0] - grid.x0) // grid.res) // CELLS * CELLS)
        c_hi = min(grid.width, int((tb[2] - grid.x0) // grid.res) + 1)
        r_lo = max(0, int((grid.y0 - tb[3]) // grid.res) // CELLS * CELLS)
        r_hi = min(grid.height, int((grid.y0 - tb[1]) // grid.res) + 1)
        n = 0
        for r0 in range(r_lo, r_hi, CELLS):
            for c0 in range(c_lo, c_hi, CELLS):
                r1, c1 = min(grid.height, r0 + CELLS), min(grid.width, c0 + CELLS)
                g1 = Grid(grid.x0 + c0 * grid.res - HALO, grid.y0 - r0 * grid.res + HALO, 1.0,
                          (c1 - c0) * F + 2 * HALO, (r1 - r0) * F + 2 * HALO)
                z = warp_window(src, g1)
                if z is None:
                    continue
                valid = np.isfinite(z)
                if valid.mean() < 0.02:
                    continue
                n += 1
                pf = post_fields(z, valid)
                sl = (slice(HALO, HALO + (r1 - r0) * F), slice(HALO, HALO + (c1 - c0) * F))
                v = ndi.binary_erosion(valid, iterations=4)[sl]       # drop posts near DTM edges (filter edge effects)
                zc = z[sl]
                f = {k: np.where(v, a[sl], np.nan) for k, a in pf.items()}
                with np.errstate(all="ignore"):
                    cov = blocks(v.astype(np.float32), F).mean(2)
                    sw_b = blocks(f["sw"], F)
                    blk = {
                        "z_mean": np.nanmean(blocks(np.where(v, zc, np.nan), F), 2),
                        "cover": cov,
                        "sw_p90": np.nanpercentile(sw_b, 90, axis=2),
                        "sw_max": np.nanmax(sw_b, 2),
                        "gt20": np.nanmean(np.where(np.isfinite(sw_b), sw_b > 20, np.nan), 2),
                        "gt25": np.nanmean(np.where(np.isfinite(sw_b), sw_b > 25, np.nan), 2),
                        "gt30": np.nanmean(np.where(np.isfinite(sw_b), sw_b > 30, np.nan), 2),
                        "step_p99": np.nanpercentile(np.abs(blocks(f["relief"], F)), 99, axis=2),
                        "bed_E": np.nanmean(blocks(f["energy"], F), 2),
                        "bed_C": np.nanmean(blocks(f["coh"], F), 2),
                        "rough": np.sqrt(np.nanmean(blocks(f["rough"] ** 2, F), 2)),
                    }
                keep = cov > 0
                for k2 in STATS:
                    tgt = out[k2][r0:r1, c0:c1]
                    tgt[keep] = blk[k2][keep]
    print(f"  {key}: {n} chunks, {time.time() - t0:.0f}s", flush=True)
    # noise floor of this product over gentle terrain
    gentle = (out["cover"] > 0.9) & (out["sw_p90"] < 5)
    noise = {"bed_E": float(np.nanpercentile(out["bed_E"][gentle], 10)) if gentle.any() else 0.0,
             "rough": float(np.nanpercentile(out["rough"][gentle], 10)) if gentle.any() else 0.0,
             "step_p99": float(np.nanpercentile(out["step_p99"][gentle], 10)) if gentle.any() else 0.0}
    out["_noise"] = noise
    return out


def merge_tiles(tiles: list[tuple[str, dict]], grid: Grid) -> dict:
    merged = {n: np.full((grid.height, grid.width), np.nan, np.float32) for n in STATS}
    merged["cover"][:] = 0
    tile_id = np.full((grid.height, grid.width), -1, np.int8)
    for i, (key, t) in enumerate(tiles):
        nz = t["_noise"]
        take = (t["cover"] > 0.5) & (tile_id < 0)
        corr = dict(t)
        for k2 in ("bed_E", "rough", "step_p99"):
            corr[k2] = np.sqrt(np.maximum(0.0, t[k2] ** 2 - nz[k2] ** 2))
        for k2 in STATS:
            merged[k2][take] = corr[k2][take]
        tile_id[take] = i
    merged["tile_id"] = tile_id
    return merged


def blend_elevation(ctx: np.ndarray, hi: np.ndarray, cover: np.ndarray, feather_cells: int = 20) -> np.ndarray:
    """HiRISE block means where covered, CTX elsewhere; the HiRISE-CTX offset is low-passed and applied to CTX near
    the seam, and the weight ramps over `feather_cells` so there is no step at a DTM edge."""
    have = np.isfinite(hi) & (cover > 0.5)
    diff = np.where(have, hi - ctx, 0.0)
    wsum = ndi.gaussian_filter(have.astype(np.float32), 30)
    off = ndi.gaussian_filter(diff, 30) / np.maximum(wsum, 1e-3)
    off = np.where(wsum > 0.02, off, 0.0)
    d_in = ndi.distance_transform_edt(have)
    w = np.clip(d_in / feather_cells, 0, 1)
    ctx_adj = ctx + off * np.clip(wsum / 0.2, 0, 1)
    return np.where(have, w * hi + (1 - w) * ctx_adj, ctx_adj).astype(np.float32)


def dem_blunders(z: np.ndarray, res: float, slope_deg_min: float = 45.0, resid_m: float = 8.0):
    """Stereo-DEM blunders (spikes, pits, striping): cells steeper than 45 deg at the DEM baseline whose height departs
    from the 90 m median by more than 8 m, grown by one cell. Real slopes that steep are rare at 20 m posting and are
    no-go anyway; flagging them separately tells the crew "no reliable data here" instead of inventing a cliff, and the
    median value is used for derived products (slope statistics, horizons) so one bad post cannot cast a false shadow.
    Returns (mask, median)."""
    med = ndi.median_filter(z, size=9)
    steep = ndi.maximum_filter(slope_deg(z, res), size=3) > slope_deg_min   # a spike's own central slope is not steep
    bad = steep & (np.abs(z - med) > resid_m)
    return ndi.binary_dilation(bad, iterations=1), med


def dem_seams(z: np.ndarray, res: float, step_min: float = 6.0, flat_max_deg: float = 8.0, min_len_m: float = 2000.0):
    """Mosaic seams: where a DEM mosaic joins two source DEMs with a vertical offset, the join shows as a long, straight
    step one or two posts wide between flat ground on both sides. Real scarps are rarely all three (long AND straight
    AND flat on both sides at 20 m). Detection: a >= 6 m step across 40 m, ground within 8 deg 50 m either side, then
    connected lines longer than 2 km and at least 15x longer than wide (principal axes). Returns the seam mask."""
    s = slope_deg(z, res)
    cand = np.zeros(z.shape, bool)
    for axis in (0, 1):
        a = np.moveaxis(z, axis, 0)
        sa = np.moveaxis(s, axis, 0)
        c = np.zeros(a.shape, bool)
        step = np.abs(a[4:] - a[:-4])                     # z(p+2) - z(p-2): 40 m baseline
        flat = np.maximum(sa[:-10], sa[10:]) < flat_max_deg  # 50 m either side
        c[5:-5] = (step[3:-3] > step_min) & flat & (sa[5:-5] > 12)
        cand |= np.moveaxis(c, 0, axis)
    lab, n = ndi.label(ndi.binary_dilation(cand, iterations=2))
    seam = np.zeros(z.shape, bool)
    for i, sl in enumerate(ndi.find_objects(lab), start=1):
        rr, cc = np.nonzero(lab[sl] == i)
        if rr.size < min_len_m / res:
            continue
        xy = np.stack([rr, cc], 1).astype(float) * res
        ev = np.sort(np.linalg.eigvalsh(np.cov(xy.T)))
        length, width = 4 * np.sqrt(ev[1]), 4 * np.sqrt(max(ev[0], 1e-6))
        if length >= min_len_m and length / width >= 15:
            seam[sl] |= lab[sl] == i
    return seam & cand | (seam & ndi.binary_dilation(cand, iterations=1))


def membrane_fill(z: np.ndarray, band: np.ndarray, iters: int = 400) -> np.ndarray:
    """Replace z inside `band` by the smooth (Laplace) surface that meets the ground on both sides: a seam's step
    becomes a gentle ramp. Starts from a normalised convolution, then Jacobi iterations inside the band's box."""
    out = z.copy()
    if not band.any():
        return out
    r0, r1 = np.nonzero(band.any(1))[0][[0, -1]]
    c0, c1 = np.nonzero(band.any(0))[0][[0, -1]]
    pad = 3
    sl = (slice(max(0, r0 - pad), r1 + pad + 1), slice(max(0, c0 - pad), c1 + pad + 1))
    zz, bb = out[sl].astype(np.float64), band[sl]
    w = (~bb).astype(np.float64)
    zz[bb] = (ndi.gaussian_filter(np.where(bb, 0, zz), 15) / np.maximum(ndi.gaussian_filter(w, 15), 1e-6))[bb]
    k = np.array([[0, 0.25, 0], [0.25, 0, 0.25], [0, 0.25, 0]])
    for _ in range(iters):
        zz[bb] = ndi.convolve(zz, k, mode="nearest")[bb]
    out[sl] = zz.astype(out.dtype)
    return out


def site_grids(site: dict) -> tuple[Grid, Grid]:
    so = tuple(site.get("snap_origin", (0.0, 0.0)))
    ops = grid_from_lonlat(*site["ops_area"], res=10.0, snap_origin=so, name="ops10")
    reg = grid_from_lonlat(*site["regional_area"], res=100.0, snap=100.0, snap_origin=so, name="reg100")
    return ops, reg


def main(site: dict):
    t0 = time.time()
    RAW, WORK, src = site["raw"], site["work"], site["sources"]
    OPS, REG = site_grids(site)
    print(f"site {site['id']}: ops grid {OPS.width} x {OPS.height} @ {OPS.res} m")
    ctx = read_to_grid(os.path.join(RAW, src["regional_dem"]), OPS)
    report = {"site": site["id"]}
    bad, med = dem_blunders(ctx, OPS.res)
    ctx = np.where(bad, med, ctx).astype(np.float32)
    report["dem_blunders"] = {"cells": int(bad.sum()), "frac": float(bad.mean())}
    np.save(os.path.join(WORK, "dem_bad.npy"), bad)
    print("regional DEM blunder screen", report["dem_blunders"])
    seam = dem_seams(ctx, OPS.res)
    band = ndi.binary_dilation(seam, iterations=15)          # +-150 m ramp
    ctx = membrane_fill(ctx, band).astype(np.float32)
    report["dem_seams"] = {"cells": int(seam.sum()), "band_cells": int(band.sum()), "frac": float(band.mean())}
    np.save(os.path.join(WORK, "dem_seam.npy"), band)
    print("regional DEM seam repair", report["dem_seams"])
    trn = np.full_like(ctx, np.nan)
    if src.get("check_dem"):
        trn = read_to_grid(os.path.join(RAW, src["check_dem"]), OPS)
        both = np.isfinite(ctx) & np.isfinite(trn)
        d = (ctx - trn)[both]
        report["ctx_vs_trn"] = {"n": int(d.size), "mean_m": float(d.mean()), "sd_m": float(d.std()),
                                "p95_abs_m": float(np.percentile(np.abs(d), 95))}
        print("regional DEM vs check DEM", report["ctx_vs_trn"])
    reg = read_to_grid(os.path.join(RAW, src["regional_dem"]), REG, Resampling.average)
    tiles, used = [], []
    for h in src.get("hires_dtms", []):   # priority order
        path = os.path.join(RAW, h["file"])
        if not os.path.exists(path):
            if not h.get("optional"):
                raise SystemExit(f"missing required DTM {h['file']} (run pipeline/fetch_data.py)")
            print(f"  optional DTM {h['key']} not present, skipped")
            continue
        tiles.append((h["key"], process_tile(h["key"], path, OPS)))
        used.append(h)
    json.dump(used, open(os.path.join(WORK, "hires_used.json"), "w"), indent=1)
    report["hirise_noise"] = {k: t["_noise"] for k, t in tiles}
    print("noise floors", report["hirise_noise"])
    m = merge_tiles(tiles, OPS)
    have = (m["cover"] > 0.9) & np.isfinite(m["z_mean"])
    if have.any():
        d2 = (m["z_mean"] - ctx)[have]
        report["hirise_vs_ctx"] = {"n": int(d2.size), "mean_m": float(d2.mean()), "sd_m": float(d2.std()),
                                   "p95_abs_m": float(np.percentile(np.abs(d2), 95))}
    elev = blend_elevation(ctx, m["z_mean"], m["cover"])
    np.save(os.path.join(WORK, "elev_ops10.npy"), elev)
    np.save(os.path.join(WORK, "ctx_ops10.npy"), ctx)
    np.save(os.path.join(WORK, "trn_ops10.npy"), trn)
    np.save(os.path.join(WORK, "ctx_reg100.npy"), reg)
    for k2 in STATS + ["tile_id"]:
        np.save(os.path.join(WORK, f"hi_{k2}.npy"), m[k2])
    report["tiles"] = [k for k, _ in tiles]
    report["grids"] = {"ops": OPS.to_json(), "reg": REG.to_json()}
    json.dump(report, open(os.path.join(WORK, "terrain_report.json"), "w"), indent=1)
    json.dump({"ops": OPS.to_json(), "reg": REG.to_json()}, open(os.path.join(WORK, "grids.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in report.items() if k != "grids"}, indent=1))
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main(cli_site(__doc__.splitlines()[1]))
