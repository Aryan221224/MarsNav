"""
build_magnetic.py - Mars's crustal magnetic field for the whole-planet atlas (Landing mode).

Input: the Mars Global Surveyor MAG/ER map of Connerney et al. (2001, GRL 28, 4015): the median of every night-side
observation in each 1 x 1 deg bin at the mapping altitude of 400 +/- 30 km, as radial (Br), theta (Bt) and phi (Bp)
components in nT. USGS Astrogeology's ESRI-grid version of the NASA GSFC files (1.7 MB, pinned by SHA-256), read with
rasterio. Check: Br = 138.271 nT at 171.5 E 54.5 S and -7.367 nT at 200.5 E 45.5 N, the README's own examples.

    python tools/build_magnetic.py      # download (once), verify, write app/data/global/magnetic_mgs.{json,bin.gz}

Output: int16 in 0.1 nT, three planes (Br, Bt, Bp), 180 rows from 90 N x 360 columns from 180 W (cell centres at
half degrees). NASA data, public domain.
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import time
import zipfile

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
from fetch_data import download, sha256

URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/pigpen/mars/magnetic/mars_magnetic_grids_meters.zip"
SHA = "265eb68850cccc2c913ba0b0b502b4e443786d21b90dc92e72c015086c8099c8"
SRC = os.path.join(ROOT, "data_cache", "magnetic", "mars_magnetic_grids_meters.zip")
OUT = os.path.join(ROOT, "app", "data", "global")
GRIDS = {"br": "marsmag_rdial", "bt": "marsmag_theta", "bp": "marsmag_phi"}


def main() -> int:
    import rasterio
    if not os.path.exists(SRC):
        os.makedirs(os.path.dirname(SRC), exist_ok=True)
        download(URL, SRC)
    if sha256(SRC) != SHA:
        raise SystemExit(f"{SRC}: SHA-256 does not match the pinned value")
    work = os.path.join(os.path.dirname(SRC), "grids")
    with zipfile.ZipFile(SRC) as z:
        z.extractall(work)
    planes = []
    for folder in GRIDS.values():
        with rasterio.open(os.path.join(work, "mars_magnetic_grids", folder)) as d:
            a = d.read(1).astype(np.float64)
            a[a < -1e30] = np.nan
            assert a.shape == (180, 360), a.shape
            t = d.transform
            # the grid's corner is (-180 deg, 90 deg) in 59 274.7 m per degree (equirectangular, R = 3396.19 km)
            assert abs(t.c / t.a + 180) < 1e-3 and abs(t.f / -t.e - 90) < 1e-3, t
            planes.append(a)
    br = planes[0]
    chk = (br[int(90 + 54.5), int(171.5 + 180)], br[int(90 - 45.5), int(200.5 - 360 + 180)])
    assert abs(chk[0] - 138.271) < 0.01 and abs(chk[1] + 7.367) < 0.01, chk
    q = np.stack([np.round(np.nan_to_num(p, nan=0.0) * 10) for p in planes]).astype("<i2")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "magnetic_mgs.bin.gz"), "wb") as fo, gzip.GzipFile(filename="", mode="wb", fileobj=fo, mtime=0) as f:
        f.write(q.tobytes())
    meta = {"what": "Mars crustal magnetic field at 400 +/- 30 km altitude (MGS MAG/ER, night-side medians in 1 x 1 deg bins)",
            "cite": "Connerney J.E.P. et al. 2001, Geophys. Res. Lett. 28, 4015-4018, doi:10.1029/2001GL013619 (NASA GSFC); "
                    "ESRI grids by USGS Astrogeology (T. Hare)",
            "url": "https://mgs-mager.gsfc.nasa.gov/publications/grl_28_connerney/data/grl_28_connerney_data.html", "source_zip": URL, "sha256": SHA,
            "licence": "public domain (NASA)", "built": time.strftime("%Y-%m-%d"), "tool": "tools/build_magnetic.py",
            "file": "magnetic_mgs.bin.gz", "dtype": "int16", "scale_nT": 0.1, "planes": ["br", "bt", "bp"], "shape": [3, 180, 360],
            "grid": {"lat0": 89.5, "lon0": -179.5, "step_deg": 1.0, "note": "cell centres, rows from 89.5 N, columns from 179.5 W"},
            "range_nT": {k: [round(float(np.nanmin(p)), 1), round(float(np.nanmax(p)), 1)] for k, p in zip(GRIDS, planes)},
            "check": {"br_171.5E_54.5S": round(float(chk[0]), 3), "br_200.5E_45.5N": round(float(chk[1]), 3)}}
    with open(os.path.join(OUT, "magnetic_mgs.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"  wrote app/data/global/magnetic_mgs.bin.gz ({os.path.getsize(os.path.join(OUT, 'magnetic_mgs.bin.gz')) / 1e3:.0f} kB); "
          f"Br {meta['range_nT']['br']} nT; README checks {meta['check']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
