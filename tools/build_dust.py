"""
build_dust.py - the seasonal dust climatology MarsNav uses for sunlight, battery and visibility planning.

Input: the Mars Climate Database "dust scenarios" (Montabone et al. 2015, 2020): one daily map of 9.3 um absorption
column dust optical depth (CDOD) per sol, kriged to a regular 3 x 3 deg grid and normalised to 610 Pa, for each Mars
year from MY 24 (1999) to MY 36 (2022), from TES, THEMIS and MCS retrievals. 13 NetCDF-3 files, 57 MB each, pinned by
SHA-256 below; downloaded once into data_cache/dust (resumable).

    python tools/build_dust.py            # download (once), verify, build app/data/global/dust_cdod.{json,bin.gz}
    python tools/build_dust.py --check    # verify the inputs that are present, build nothing

Output (all values are the 9.3 um absorption CDOD at 610 Pa, as in the source):
  stats   p10, median and p90 over every sol of every year that falls in each 10 deg Ls bin, on the 3 deg grid
          (36 bins x 60 x 120 per statistic; about 240 sols per cell and bin)
  years   the mean of each year in each 10 deg Ls bin, on a 6 deg grid (13 years x 36 x 30 x 60): what one particular
          year (a global dust storm year, say) looked like
Encoding: uint8, tau = TAU_MAX * (q / 254)^2 (finer steps where the air is clear), 255 = no data. MY 24 before Ls 105 is
not used: the source fills it with the average of MY 25 and MY 26 (its own title says so), which would count those
years twice.

To use it: visible-band optical depth ~ 2.6 x the 9.3 um absorption value, and the local column scales with the local
surface pressure: tau_local = tau_610 x p / 610 Pa (both conversions from the source page). engine/dust.js and
planet/dust.py do this.

Licence: the source is CC BY-SA 3.0 (Montabone et al.); this derived product is distributed under the same licence.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
from fetch_data import download, sha256

BASE = "https://www-mars.lmd.jussieu.fr/mars/dust_climatology/dataset_v2/"
FILES = {
    "dustscenario_MY24_v2-0.nc": "48bb64656492f200271e18ee52ca3340aeb3a8f410f07cb7c605f30b003ec501",
    "dustscenario_MY25_v2-0.nc": "d7449ebf40097eb5146301b3fbf30f1e941e4aa32ae56f5d14ea2c1dbc4d23e7",
    "dustscenario_MY26_v2-0.nc": "2142a20cb1124f77fad2aeab8bef7cbd93d4f68a0c96c0324e6c1c04f8b4bd32",
    "dustscenario_MY27_v2-0.nc": "f655fa7f394d73bc214761a09c86ff2422af2f99ac29991da2f944b1d6cdc786",
    "dustscenario_MY28_v2-0.nc": "b2abd93cab38edc4cbb8de9c472794ebc0e1eb2cda13c1e52e4697c1a137e7df",
    "dustscenario_MY29_v2-0.nc": "142d8f1dba4c896a7b4863e92d84b0f69bc4101f4867b904048a60c641f7b882",
    "dustscenario_MY30_v2-0.nc": "e1ee0c30a26a9fe8dae25e4891760ff18a3a3dc96bef80aa746af544248eb9ee",
    "dustscenario_MY31_v2-0.nc": "d382ee1817365263bde0a3de8d5b1f0a57fdf0bb7ae55318bf9c14958b19dd43",
    "dustscenario_MY32_v2-0.nc": "76a13696333a3d1ad184e098325f51aa39288bcc29bda0b8eb3cf6ef280ad9fc",
    "dustscenario_MY33_v2-1.nc": "91c251681b1060e4816ac2ff94bf7636e77a7572bbff3c4c0a99048b15ff85da",
    "dustscenario_MY34_v2-5.nc": "032b9627247e9cc4397c9f007cc8f97a01acf689006b46ff3a51e5abed828797",
    "dustscenario_MY35_v2-5.nc": "95613d68e2d03904bfd93612f2fe70e84f8410b00ef33cafe59d77d50a41063a",
    "dustscenario_MY36_v2-5.nc": "f670e8b1ccbaf5ee0f76473ff6e34965db8e5eac88fba494f044730f2788cefc",
}
SRC_DIR = os.path.join(ROOT, "data_cache", "dust")
OUT_DIR = os.path.join(ROOT, "app", "data", "global")
TAU_MAX = 9.5          # above every value in the record (MY 34 peaks at 9.01)
NBIN = 36              # 10 deg of Ls
SYNTHETIC = {24: (0.0, 105.0)}   # Ls ranges the source fills from other years (see the file titles)


def enc(t: np.ndarray) -> np.ndarray:
    ok = np.isfinite(t)
    q = np.round(np.sqrt(np.clip(np.where(ok, t, 0), 0, TAU_MAX) / TAU_MAX) * 254)
    out = q.astype(np.uint8)
    out[~ok] = 255
    return out


def dec(q: np.ndarray) -> np.ndarray:
    t = TAU_MAX * (q.astype(np.float64) / 254.0) ** 2
    return np.where(q == 255, np.nan, t)


def fetch(check_only: bool) -> list[str]:
    os.makedirs(SRC_DIR, exist_ok=True)
    out = []
    for name, digest in FILES.items():
        p = os.path.join(SRC_DIR, name)
        if not os.path.exists(p):
            if check_only:
                print(f"  missing  {name}")
                continue
            print(f"  download {name}")
            download(BASE + name, p)
        got = sha256(p)
        if got != digest:
            raise SystemExit(f"{name}: SHA-256 {got} does not match the pinned {digest} (delete it and run again)")
        print(f"  ok       {name}")
        out.append(p)
    return out


def read(path: str):
    from scipy.io import netcdf_file
    with netcdf_file(path, "r", mmap=False) as d:
        title = d.title.decode() if isinstance(d.title, bytes) else str(d.title)
        return {"title": title, "ls": np.array(d.variables["Ls"][:], np.float64),
                "lat": np.array(d.variables["latitude"][:], np.float64), "lon": np.array(d.variables["longitude"][:], np.float64),
                "cdod": np.array(d.variables["cdod610"][:], np.float32)}


def build(paths: list[str]) -> dict:
    t0 = time.time()
    years, per_bin, yearly, storms = [], [[] for _ in range(NBIN)], [], []
    lat = lon = None
    for p in paths:
        my = int(os.path.basename(p).split("_MY")[1][:2])
        d = read(p)
        lat, lon = d["lat"], d["lon"]
        c, ls = d["cdod"], d["ls"]
        use = np.ones(len(ls), bool)
        if my in SYNTHETIC:
            a, b = SYNTHETIC[my]
            use &= ~((ls >= a) & (ls < b))
        b = np.minimum(NBIN - 1, (ls // (360 / NBIN)).astype(int))
        ymean = np.full((NBIN, 30, 60), np.nan, np.float32)
        for k in range(NBIN):
            sel = use & (b == k)
            if not sel.any():
                continue
            per_bin[k].append(c[sel])
            m = c[sel].mean(axis=0)                                              # (60, 120)
            ymean[k] = m.reshape(30, 2, 60, 2).mean(axis=(1, 3))                  # 6 deg cells
        yearly.append(ymean)
        w = np.cos(np.radians(lat))[:, None] * np.ones((1, len(lon)))
        gm = (c * w).sum(axis=(1, 2)) / w.sum()
        gm = np.where(use, gm, np.nan)
        k = int(np.nanargmax(gm))
        storms.append({"my": my, "global_mean_max": round(float(gm[k]), 3), "ls": round(float(ls[k]), 1)})
        years.append(my)
        print(f"  MY {my}: {use.sum()} sols used, global-mean peak {gm[k]:.2f} at Ls {ls[k]:.0f}")
    stats = np.full((3, NBIN, len(lat), len(lon)), np.nan, np.float32)
    nsol = []
    for k in range(NBIN):
        a = np.concatenate(per_bin[k], axis=0)
        nsol.append(int(a.shape[0]))
        stats[:, k] = np.percentile(a, [10, 50, 90], axis=0)
    print(f"  statistics: {min(nsol)}-{max(nsol)} sols per Ls bin ({time.time() - t0:.0f} s)")
    return {"years": years, "stats": stats, "yearly": np.stack(yearly), "lat": lat, "lon": lon, "storms": storms, "nsol": nsol}


def write(res: dict) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    qs, qy = enc(res["stats"]), enc(res["yearly"])
    raw = qs.tobytes() + qy.tobytes()
    with open(os.path.join(OUT_DIR, "dust_cdod.bin.gz"), "wb") as fo, \
            gzip.GzipFile(filename="", mode="wb", fileobj=fo, compresslevel=9, mtime=0) as f:   # byte-identical rebuilds
        f.write(raw)
    lat, lon = res["lat"], res["lon"]
    gstorm = [s for s in res["storms"] if s["global_mean_max"] >= 0.8]
    meta = {
        "what": "Seasonal climatology of Mars column dust optical depth (9.3 um absorption, normalised to 610 Pa)",
        "source": "Mars Climate Database dust scenarios v2.x (kriged daily maps), MY 24-36, from TES, THEMIS and MCS",
        "cite": "Montabone L. et al. 2015, Icarus 251, 65-95, doi:10.1016/j.icarus.2014.12.034; Montabone L. et al. 2020, "
                "JGR Planets 125, e2019JE006111, doi:10.1029/2019JE006111",
        "url": "https://www-mars.lmd.jussieu.fr/mars/dust_climatology/",
        "licence": "CC BY-SA 3.0 (source and this derived product)",
        "built": time.strftime("%Y-%m-%d"), "tool": "tools/build_dust.py",
        "inputs": FILES,
        "file": "dust_cdod.bin.gz",
        "encoding": {"dtype": "uint8", "tau_max": TAU_MAX, "formula": "tau = tau_max * (q / 254)^2", "nodata": 255},
        "ls_bins": {"n": NBIN, "width_deg": 360 / NBIN, "centres_deg": [round((k + 0.5) * 360 / NBIN, 1) for k in range(NBIN)],
                    "sols_per_bin": res["nsol"]},
        "grid": {"lat": [float(lat[0]), float(lat[-1])], "lon": [float(lon[0]), float(lon[-1])], "nlat": len(lat), "nlon": len(lon),
                 "step_deg": 3.0, "note": "grid points: latitude from north to south, longitude from -180 east"},
        "stats": {"order": ["p10", "p50", "p90"], "shape": [3, NBIN, len(lat), len(lon)], "offset": 0},
        "years": {"list": res["years"], "shape": [len(res["years"]), NBIN, 30, 60], "offset": int(res["stats"].size),
                  "grid": {"lat0": 87.0, "lon0": -177.0, "step_deg": 6.0, "nlat": 30, "nlon": 60}, "statistic": "mean of the year in the bin",
                  "excluded": {"24": "Ls 0-105 (filled from MY 25/26 in the source)"}},
        "storms": res["storms"],
        "global_storm_years": [s["my"] for s in gstorm],
        "use": {"visible_factor": 2.6, "extinction_factor": 1.3, "pressure_ref_pa": 610,
                "note": "visible column optical depth at a place ~ 2.6 x value x (local surface pressure / 610 Pa)"},
    }
    with open(os.path.join(OUT_DIR, "dust_cdod.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"  wrote app/data/global/dust_cdod.bin.gz ({os.path.getsize(os.path.join(OUT_DIR, 'dust_cdod.bin.gz')) / 1e6:.2f} MB) "
          f"and dust_cdod.json; global dust storm years: {meta['global_storm_years']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--check", action="store_true", help="verify the inputs present, build nothing")
    a = ap.parse_args()
    paths = fetch(a.check)
    if a.check:
        return 0
    if len(paths) != len(FILES):
        raise SystemExit("some inputs are missing")
    write(build(paths))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
